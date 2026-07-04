import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { buildWorkCacheKey, buildWorkMediaCacheKey, selectMediaAssetUrls } from "@/lib/douyin/assets";
import { collectWorkMetadata } from "@/lib/douyin/detail";
import { buildDouyinWorkUrl, isSupportedMediaUrl } from "@/lib/douyin/download";
import {
  CompletedMediaCacheRequiredError,
  downloadRemoteMediaToCachedFile,
  prepareMediaCacheForWork,
  prepareTranscribableWavAudioFromCachedMedia,
  streamRemoteMediaToCachedFile,
} from "@/lib/media/audio";
import { uploadAsrAudioFile } from "@/lib/oss/asr-audio";
import { upsertAsrAudioCache } from "@/lib/transcript/db";
import { DOUYIN_KINDS, MEDIA_ASSET_KINDS, type MediaAssetKind } from "@/types/douyin";

export const runtime = "nodejs";
export const maxDuration = 120;

const OFFICIAL_AD_VIDEO_UNSUPPORTED_MESSAGE = "官方广告视频无法缓存，请尝试其他抖音作品链接。";

const DownloadQuerySchema = z.object({
  id: z.string().regex(/^\d{6,30}$/),
  kind: z.enum(DOUYIN_KINDS),
  asset: z.enum(MEDIA_ASSET_KINDS),
  cacheRunId: z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/).optional(),
});

export async function GET(request: Request) {
  const user = requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const url = new URL(request.url);
  const requestRange = request.headers.get("range");
  const parsed = DownloadQuerySchema.safeParse({
    id: url.searchParams.get("id"),
    kind: url.searchParams.get("kind"),
    asset: url.searchParams.get("asset"),
    cacheRunId: url.searchParams.get("cacheRunId") || undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "下载参数无效。" }, { status: 400 });
  }

  const { id, kind, asset, cacheRunId } = parsed.data;
  const isPreview = url.searchParams.get("preview") === "1";

  const work = { id, kind };
  const workKey = buildWorkCacheKey(work);
  await prepareMediaCacheForWork(user.id, workKey, cacheRunId);

  if (asset === "originalAudio") {
    try {
      const videoCacheKey = buildWorkMediaCacheKey(work, "video");
      const audio = await prepareTranscribableWavAudioFromCachedMedia(user.id, videoCacheKey, undefined, {
        signal: request.signal,
      });
      const asrAudio = await uploadAsrAudioFile({
        filePath: audio.filePath,
        userId: user.id,
        workKey,
      });
      upsertAsrAudioCache({
        durationSeconds: audio.durationSeconds,
        objectKey: asrAudio.objectKey,
        userId: user.id,
        workKey,
      });
      return await fileResponse(audio.filePath, {
        asrAudio,
        contentType: "audio/wav",
        filename: buildFilename(id, asset, "audio/wav"),
        inline: isPreview,
        range: requestRange,
      });
    } catch (error) {
      return downloadErrorResponse(error);
    }
  }

  const finalUrl = buildDouyinWorkUrl(kind, id);
  const metadata = await collectWorkMetadata({ id, kind, finalUrl });
  const assetUrls = selectMediaAssetUrls(asset, metadata);

  if (assetUrls.length === 0) {
    return NextResponse.json({ error: "没有采集到可下载资源。" }, { status: 404 });
  }
  if (assetUrls.some((assetUrl) => !isSupportedMediaUrl(assetUrl))) {
    return NextResponse.json({ error: "资源地址不是有效的 HTTPS 媒体地址。" }, { status: 400 });
  }

  try {
    if (asset === "video") {
      const media = await streamRemoteMediaToCachedFile(user.id, assetUrls, {
        cacheKey: buildWorkMediaCacheKey(work, asset),
        signal: request.signal,
      });
      const contentType = media.contentType ?? defaultContentType(asset);
      if (media.kind === "cached") {
        return await fileResponse(media.filePath, {
          contentType,
          filename: buildFilename(id, asset, contentType),
          inline: isPreview,
          range: requestRange,
        });
      }

      return streamingMediaResponse(media.stream, {
        contentLength: media.contentLength,
        contentType,
        filename: buildFilename(id, asset, contentType),
        inline: isPreview,
      });
    }

    const media = await downloadRemoteMediaToCachedFile(user.id, assetUrls, {
      cacheKey: buildWorkMediaCacheKey(work, asset),
      signal: request.signal,
    });
    const contentType = media.contentType ?? defaultContentType(asset);
    return await fileResponse(media.filePath, {
      contentType,
      filename: buildFilename(id, asset, contentType),
      inline: isPreview,
      range: requestRange,
    });
  } catch (error) {
    return downloadErrorResponse(error);
  }
}

function streamingMediaResponse(
  stream: ReadableStream<Uint8Array>,
  options: {
    contentLength?: number;
    contentType: string;
    filename: string;
    inline: boolean;
  },
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": options.contentType,
    "content-disposition": `${options.inline ? "inline" : "attachment"}; filename="${options.filename}"`,
    "x-accel-buffering": "no",
  });
  if (options.contentLength) {
    headers.set("content-length", String(options.contentLength));
  }

  return new Response(stream, { headers });
}

async function fileResponse(
  filePath: string,
  options: {
    asrAudio?: { objectKey: string; signedUrl: string };
    contentType: string;
    filename: string;
    inline: boolean;
    range: string | null;
  },
): Promise<Response> {
  const size = (await stat(filePath)).size;
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-type": options.contentType,
    "content-disposition": `${options.inline ? "inline" : "attachment"}; filename="${options.filename}"`,
  });
  if (options.asrAudio) {
    headers.set("x-echolens-asr-audio-object-key", encodeURIComponent(options.asrAudio.objectKey));
    headers.set("x-echolens-asr-audio-url", encodeURIComponent(options.asrAudio.signedUrl));
  }
  const range = parseSingleRange(options.range, size);

  if (!range) {
    headers.set("content-length", String(size));
    return new Response(readFileStream(filePath), { headers });
  }

  headers.set("content-length", String(range.end - range.start + 1));
  headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  return new Response(readFileStream(filePath, range), { status: 206, headers });
}

function readFileStream(filePath: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(filePath, range)) as ReadableStream<Uint8Array>;
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
    if (/\bHTTP 404\b/.test(error.message)) {
      return OFFICIAL_AD_VIDEO_UNSUPPORTED_MESSAGE;
    }
    return error.message.trim();
  }

  return "媒体资源下载失败。";
}

function downloadErrorResponse(error: unknown): NextResponse {
  if (error instanceof CompletedMediaCacheRequiredError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  const message = formatDownloadError(error);
  return NextResponse.json(
    { error: message },
    { status: message === OFFICIAL_AD_VIDEO_UNSUPPORTED_MESSAGE ? 400 : 502 },
  );
}
