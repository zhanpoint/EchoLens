import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import {
  createTranscribableAudioFileFromNode,
  fetchRemoteMedia,
  type MediaSourcePlatform,
} from "@/lib/media/audio";
import {
  buildConfiguredPublicOssObjectUrl,
  getPublicOssObjectInfo,
  putPublicOssStream,
} from "@/lib/oss/object-store";

const OPEN_AUDIO_PREFIX = "echolens/open-api/audio";
const audioTasks = new Map<string, Promise<OpenAudioCacheEntry>>();

export type OpenAudioCacheEntry = {
  durationSeconds: number;
  url: string;
};

export async function ensureOpenAudioCache(input: {
  durationSeconds?: number;
  mediaId: string;
  mediaSource: MediaSourcePlatform;
  sources: readonly string[];
  signal?: AbortSignal;
}): Promise<OpenAudioCacheEntry> {
  const objectKey = openAudioObjectKey(input.mediaSource, input.mediaId);
  const existing = audioTasks.get(objectKey);
  if (existing) return await existing;

  const task = ensureAudioObject({ ...input, objectKey }).finally(() => {
    if (audioTasks.get(objectKey) === task) audioTasks.delete(objectKey);
  });
  audioTasks.set(objectKey, task);
  return await task;
}

async function ensureAudioObject(input: {
  durationSeconds?: number;
  mediaSource: MediaSourcePlatform;
  objectKey: string;
  sources: readonly string[];
  signal?: AbortSignal;
}): Promise<OpenAudioCacheEntry> {
  const cached = await getPublicOssObjectInfo(input.objectKey);
  if (cached?.contentLength) return cacheEntry(input.objectKey, input.durationSeconds);

  const response = await fetchRemoteMedia(input.sources, {
    mediaSource: input.mediaSource,
    signal: input.signal,
  });
  if (!response.body) throw new Error("媒体下载响应为空。");

  if (input.mediaSource === "bilibili") {
    await putPublicOssStream({
      body: response.body,
      cacheControl: "public, max-age=86400",
      contentLength: positiveContentLength(response.headers.get("content-length")),
      contentType: "audio/mp4",
      objectKey: input.objectKey,
    });
    return cacheEntry(input.objectKey, input.durationSeconds);
  }

  const audio = await createTranscribableAudioFileFromNode(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
  );
  try {
    await putPublicOssStream({
      body: Readable.toWeb(createReadStream(audio.filePath)) as ReadableStream<Uint8Array>,
      cacheControl: "public, max-age=86400",
      contentLength: audio.sizeBytes,
      contentType: audio.contentType,
      objectKey: input.objectKey,
    });
    return cacheEntry(input.objectKey, input.durationSeconds ?? audio.durationSeconds);
  } finally {
    await audio.cleanup();
  }
}

function cacheEntry(objectKey: string, durationSeconds?: number): OpenAudioCacheEntry {
  return {
    durationSeconds: durationSeconds && durationSeconds > 0 ? durationSeconds : 0,
    url: buildConfiguredPublicOssObjectUrl(objectKey),
  };
}

function positiveContentLength(value: string | null): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function openAudioObjectKey(mediaSource: MediaSourcePlatform, mediaId: string): string {
  return `${OPEN_AUDIO_PREFIX}/${mediaSource}/${encodeURIComponent(mediaId)}/audio.m4a`;
}