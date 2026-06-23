import { NextResponse } from "next/server";
import { z } from "zod";
import { collectWorkMetadata } from "@/lib/douyin/detail";
import { buildDouyinWorkUrl, canDownloadAsset, isSupportedMediaUrl } from "@/lib/douyin/download";
import { downloadRemoteMediaToBuffer, normalizeAudioToWav } from "@/lib/media/audio";
import { withClientRouteConcurrency } from "@/lib/client-concurrency";
import type { DouyinWorkMetadata } from "@/lib/douyin/detail";
import { DOUYIN_KINDS, MEDIA_ASSET_KINDS, type MediaAssetKind } from "@/types/douyin";

export const runtime = "nodejs";
export const maxDuration = 120;

const DownloadQuerySchema = z.object({
  id: z.string().regex(/^\d{6,30}$/),
  kind: z.enum(DOUYIN_KINDS),
  asset: z.enum(MEDIA_ASSET_KINDS),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestRange = request.headers.get("range");
  const parsed = DownloadQuerySchema.safeParse({
    id: url.searchParams.get("id"),
    kind: url.searchParams.get("kind"),
    asset: url.searchParams.get("asset"),
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "下载参数无效。" }, { status: 400 });
  }

  const { id, kind, asset } = parsed.data;
  const isPreview = url.searchParams.get("preview") === "1";
  if (!canDownloadAsset(kind, asset)) {
    return NextResponse.json({ error: "当前作品类型不支持该下载资源。" }, { status: 400 });
  }

  return withClientRouteConcurrency(request, "douyin:download", async () => {
  const finalUrl = buildDouyinWorkUrl(kind, id);
  const metadata = await collectWorkMetadata({ id, kind, finalUrl });
  const assetUrls = selectAssetUrls(asset, metadata);

  if (assetUrls.length === 0) {
    return NextResponse.json({ error: "没有采集到可下载资源。" }, { status: 404 });
  }
  if (assetUrls.some((assetUrl) => !isSupportedMediaUrl(assetUrl))) {
    return NextResponse.json({ error: "资源地址不是有效的 HTTPS 媒体地址。" }, { status: 400 });
  }
  if (asset === "originalAudio") {
    try {
      const audio = await normalizeAudioToWav(assetUrls);
      return mediaBufferResponse(audio, {
        contentType: "audio/wav",
        filename: buildFilename(id, asset, "audio/wav"),
        inline: isPreview,
        range: requestRange,
      });
    } catch (error) {
      return NextResponse.json({ error: formatDownloadError(error) }, { status: 502 });
    }
  }

  try {
    const media = await downloadRemoteMediaToBuffer(assetUrls);
    const contentType = media.contentType ?? defaultContentType(asset);
    return mediaBufferResponse(media.buffer, {
      contentType,
      filename: buildFilename(id, asset, contentType),
      inline: isPreview,
      range: requestRange,
    });
  } catch (error) {
    return NextResponse.json({ error: formatDownloadError(error) }, { status: 502 });
  }
  });
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return new Uint8Array(buffer).buffer;
}

function mediaBufferResponse(
  buffer: Buffer,
  options: { contentType: string; filename: string; inline: boolean; range: string | null },
): Response {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-type": options.contentType,
    "content-disposition": `${options.inline ? "inline" : "attachment"}; filename="${options.filename}"`,
  });
  const range = parseSingleRange(options.range, buffer.byteLength);

  if (!range) {
    headers.set("content-length", String(buffer.byteLength));
    return new Response(toArrayBuffer(buffer), { headers });
  }

  const chunk = buffer.subarray(range.start, range.end + 1);
  headers.set("content-length", String(chunk.byteLength));
  headers.set("content-range", `bytes ${range.start}-${range.end}/${buffer.byteLength}`);
  return new Response(toArrayBuffer(chunk), { status: 206, headers });
}

function parseSingleRange(value: string | null, size: number): { start: number; end: number } | null {
  const match = value?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return null;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

function selectAssetUrls(
  asset: MediaAssetKind,
  metadata: DouyinWorkMetadata,
): string[] {
  return {
    cover: metadata.coverUrls ?? [],
    video: metadata.videoUrls ?? [],
    originalAudio: metadata.videoUrls ?? [],
  }[asset];
}

function buildFilename(
  id: string,
  asset: MediaAssetKind,
  contentType: string,
): string {
  return `echolens-${id}-${asset}.${readExtension(asset, contentType)}`;
}

function readExtension(asset: MediaAssetKind, contentType: string): string {
  if (contentType.includes("webp")) {
    return "webp";
  }
  if (contentType.includes("png")) {
    return "png";
  }
  if (contentType.includes("jpeg") || contentType.includes("jpg")) {
    return "jpg";
  }
  if (contentType.includes("mpeg")) {
    return "mp3";
  }
  if (contentType.includes("wav")) {
    return "wav";
  }
  if (contentType.includes("mp4")) {
    return "mp4";
  }

  return asset === "cover" ? "jpg" : asset === "originalAudio" ? "wav" : "mp4";
}

function defaultContentType(asset: MediaAssetKind): string {
  if (asset === "cover") {
    return "image/jpeg";
  }
  if (asset === "originalAudio") {
    return "audio/wav";
  }
  return "video/mp4";
}

function formatDownloadError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return "媒体资源下载失败。";
}
