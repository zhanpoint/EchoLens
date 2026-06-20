import { NextResponse } from "next/server";
import { z } from "zod";
import { collectWorkMetadata } from "@/lib/douyin/detail";
import { buildDouyinWorkUrl, canDownloadAsset, isSupportedMediaUrl } from "@/lib/douyin/download";
import { normalizeAudioToWav } from "@/lib/media/audio";
import type { DouyinWorkMetadata } from "@/lib/douyin/detail";
import { DOUYIN_KINDS, MEDIA_ASSET_KINDS, type MediaAssetKind } from "@/types/douyin";

export const runtime = "nodejs";
export const maxDuration = 120;

const DownloadQuerySchema = z.object({
  id: z.string().regex(/^\d{6,30}$/),
  kind: z.enum(DOUYIN_KINDS),
  asset: z.enum(MEDIA_ASSET_KINDS),
});

const UPSTREAM_ACCEPT: Record<MediaAssetKind, string> = {
  cover: "image/*,*/*;q=0.8",
  video: "video/mp4,*/*;q=0.8",
  originalAudio: "video/mp4,*/*;q=0.8",
  dubbedAudio: "audio/*,*/*;q=0.8",
};

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

  const finalUrl = buildDouyinWorkUrl(kind, id);
  const metadata = await collectWorkMetadata({ id, kind, finalUrl });
  const assetUrl = selectAssetUrl(asset, metadata);

  if (!assetUrl) {
    return NextResponse.json({ error: "没有采集到可下载资源。" }, { status: 404 });
  }
  if (!isSupportedMediaUrl(assetUrl)) {
    return NextResponse.json({ error: "资源地址不是有效的 HTTPS 媒体地址。" }, { status: 400 });
  }
  if (asset === "originalAudio") {
    try {
      const audio = await normalizeAudioToWav(assetUrl);
      return mediaBufferResponse(audio, {
        contentType: "audio/wav",
        filename: buildFilename(id, asset, "audio/wav"),
        inline: isPreview,
        range: requestRange,
      });
    } catch (error) {
      return NextResponse.json({ error: formatAudioError(error) }, { status: 502 });
    }
  }

  const upstream = await fetch(assetUrl, {
    headers: {
      accept: UPSTREAM_ACCEPT[asset],
      referer: "https://www.douyin.com/",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      ...(requestRange ? { range: requestRange } : {}),
    },
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: `下载资源读取失败：HTTP ${upstream.status}。` }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? defaultContentType(asset);
  const headers = new Headers({
    "content-type": contentType,
    "content-disposition": `${isPreview ? "inline" : "attachment"}; filename="${buildFilename(id, asset, contentType)}"`,
    "cache-control": "no-store",
  });
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) {
    headers.set("content-length", contentLength);
  }
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) {
    headers.set("content-range", contentRange);
  }
  const acceptRanges = upstream.headers.get("accept-ranges");
  if (acceptRanges) {
    headers.set("accept-ranges", acceptRanges);
  } else if (asset !== "cover") {
    headers.set("accept-ranges", "bytes");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
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

function selectAssetUrl(
  asset: MediaAssetKind,
  metadata: DouyinWorkMetadata,
): string | undefined {
  return {
    cover: metadata.coverUrl,
    video: metadata.videoUrl,
    originalAudio: metadata.videoUrl,
    dubbedAudio: metadata.audioUrls?.[0],
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
    return asset === "dubbedAudio" ? "m4a" : "mp4";
  }

  return asset === "cover" ? "jpg" : asset === "originalAudio" ? "wav" : asset === "dubbedAudio" ? "m4a" : "mp4";
}

function defaultContentType(asset: MediaAssetKind): string {
  if (asset === "cover") {
    return "image/jpeg";
  }
  if (asset === "originalAudio") {
    return "audio/wav";
  }
  if (asset === "dubbedAudio") {
    return "audio/mp4";
  }
  return "video/mp4";
}

function formatAudioError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return "视频原声音轨抽取失败。";
}
