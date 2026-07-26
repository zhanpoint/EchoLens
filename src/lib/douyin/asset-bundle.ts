import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { DouyinWorkMetadata } from "@/lib/douyin/detail";
import {
  isRetryableNetworkError,
  NetworkRetryExhaustedError,
  retryOperation,
} from "@/lib/http/retry";
import {
  createTranscribableAudioFileFromNode,
  fetchRemoteMedia,
  probeTranscribableAudioFromUrl,
} from "@/lib/media/audio";
import { createOssSignedUrl, deleteOssObjects, getOssObjectInfo, putOssStream } from "@/lib/oss/object-store";
import type { DouyinKind } from "@/types/douyin";

export type PreparedAssetKind = "avatar" | "cover" | "video" | "originalAudio";
export type StoredAsset = { contentType: string; objectKey: string; sizeBytes: number };
export type OriginalAudioAsset = StoredAsset & { durationSeconds: number };
export type PreparedAsset =
  | { asset: Exclude<PreparedAssetKind, "originalAudio">; value: StoredAsset }
  | { asset: "originalAudio"; value: OriginalAudioAsset };
export type AssetPreparation = {
  assets: Record<PreparedAssetKind, Promise<PreparedAsset>>;
  completed: Promise<void>;
};

type AssetInput = { id: string; kind: DouyinKind };
type CompletedVideo = { body: Uint8Array; contentType: string };

const preparationTasks = new Map<string, AssetPreparation>();
const IMMUTABLE_CACHE_CONTROL = "public, max-age=86400, immutable";
const REVALIDATED_CACHE_CONTROL = "no-cache";
const ASR_AUDIO_OBJECT_NAME = "audio.m4a";
const AUDIO_UPLOAD_ATTEMPTS = 5;

class InvalidOriginalAudioError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidOriginalAudioError";
  }
}

export function prepareAssetBundle(
  input: AssetInput,
  metadata: DouyinWorkMetadata,
  reusable: { originalAudio?: OriginalAudioAsset } = {},
): AssetPreparation {
  const taskKey = `${input.kind}:${input.id}`;
  const existing = preparationTasks.get(taskKey);
  if (existing) return existing;

  const prefix = bundlePrefix(input.kind, input.id);
  const avatarUrls = [...(metadata.authorAvatarUrls ?? [])];
  const coverUrls = [...(metadata.coverUrls ?? [])];
  const videoUrls = [...(metadata.videoUrls ?? [])];
  let completedVideo: Promise<CompletedVideo> | undefined;
  const getCompletedVideo = () => completedVideo ??= ensureCompletedVideo(
    `${prefix}video`,
    videoUrls,
  );
  const avatar = ensureImageAsset(`${prefix}avatar`, avatarUrls, "作者头像");
  const cover = ensureImageAsset(`${prefix}cover`, coverUrls, "作品封面");
  const video = ensureVideoAsset(`${prefix}video`, getCompletedVideo);
  const originalAudio = reusable.originalAudio
    ? Promise.resolve(reusable.originalAudio)
    : ensureAudioAsset(
        `${prefix}${ASR_AUDIO_OBJECT_NAME}`,
        getCompletedVideo,
        metadata.durationSeconds,
      );
  const assets: AssetPreparation["assets"] = {
    avatar: avatar.then((value) => ({ asset: "avatar", value })),
    cover: cover.then((value) => ({ asset: "cover", value })),
    video: video.then((value) => ({ asset: "video", value })),
    originalAudio: originalAudio.then((value) => ({ asset: "originalAudio", value })),
  };
  const completed = Promise.allSettled(Object.values(assets)).then(async () => {
    const videoTask = completedVideo;
    completedVideo = undefined;
    if (videoTask) {
      const completedAsset = await videoTask.catch(() => undefined);
      completedAsset?.body.fill(0);
    }
    clearStrings(avatarUrls);
    clearStrings(coverUrls);
    clearStrings(videoUrls);
    if (preparationTasks.get(taskKey)?.completed === completed) preparationTasks.delete(taskKey);
  });
  const preparation = { assets, completed };
  preparationTasks.set(taskKey, preparation);
  return preparation;
}

export async function ensurePreparedAsset(
  input: AssetInput,
  metadata: DouyinWorkMetadata,
  assetKind: PreparedAssetKind,
): Promise<PreparedAsset> {
  const prefix = bundlePrefix(input.kind, input.id);
  if (assetKind === "avatar") {
    return {
      asset: "avatar",
      value: await ensureImageAsset(`${prefix}avatar`, metadata.authorAvatarUrls ?? [], "作者头像"),
    };
  }
  if (assetKind === "cover") {
    return {
      asset: "cover",
      value: await ensureImageAsset(`${prefix}cover`, metadata.coverUrls ?? [], "作品封面"),
    };
  }

  let completedVideo: Promise<CompletedVideo> | undefined;
  const getCompletedVideo = () => completedVideo ??= ensureCompletedVideo(
    `${prefix}video`,
    metadata.videoUrls ?? [],
  );
  try {
    if (assetKind === "video") {
      return {
        asset: "video",
        value: await ensureVideoAsset(`${prefix}video`, getCompletedVideo),
      };
    }
    return {
      asset: "originalAudio",
      value: await ensureAudioAsset(
        `${prefix}${ASR_AUDIO_OBJECT_NAME}`,
        getCompletedVideo,
        metadata.durationSeconds,
      ),
    };
  } finally {
    const completed = await completedVideo?.catch(() => undefined);
    completed?.body.fill(0);
  }
}

export function assetUrl(asset: StoredAsset): string {
  return createOssSignedUrl(asset.objectKey);
}

async function ensureImageAsset(
  objectKey: string,
  urls: readonly string[],
  label: string,
): Promise<StoredAsset> {
  const cached = await getOssObjectInfo(objectKey);
  if (cached) return fromOssInfo(objectKey, cached, "image/jpeg");

  const downloaded = await retryOperation(async () => {
    const response = await fetchRemoteMedia(urls);
    try {
      const body = new Uint8Array(await response.arrayBuffer());
      if (!body.byteLength) throw new Error(`${label}为空。`);
      return {
        body,
        contentType: response.headers.get("content-type") || "image/jpeg",
      };
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  }, { shouldRetry: isRetryableNetworkError });
  const { body, contentType } = downloaded;
  const sizeBytes = body.byteLength;
  try {
    await retryOssUpload(() => uploadBuffer(body, objectKey, contentType));
    return { contentType, objectKey, sizeBytes };
  } finally {
    body.fill(0);
  }
}

async function ensureVideoAsset(
  objectKey: string,
  source: () => Promise<CompletedVideo>,
): Promise<StoredAsset> {
  const cached = await getOssObjectInfo(objectKey);
  if (cached) return fromOssInfo(objectKey, cached, "video/mp4");

  const video = await source();
  await retryOssUpload(() => uploadBuffer(video.body, objectKey, video.contentType));
  return {
    contentType: video.contentType,
    objectKey,
    sizeBytes: video.body.byteLength,
  };
}

async function ensureAudioAsset(
  objectKey: string,
  source: () => Promise<CompletedVideo>,
  durationSeconds?: number,
): Promise<OriginalAudioAsset> {
  const cached = await getOssObjectInfo(objectKey);
  if (cached) await deleteOssObjects([objectKey]);

  const video = await source();
  try {
    return await retryOperation(async () => {
      try {
        const uploaded = await uploadAudioFromVideo(video.body, objectKey, durationSeconds);
        await assertUsableOriginalAudio(objectKey, uploaded.sizeBytes);
        return uploaded;
      } catch (error) {
        await deleteOssObjects([objectKey]);
        throw error;
      }
    }, {
      attempts: AUDIO_UPLOAD_ATTEMPTS,
      shouldRetry: (error) => error instanceof InvalidOriginalAudioError || isRetryableNetworkError(error),
    });
  } catch (error) {
    if (error instanceof NetworkRetryExhaustedError && error.cause instanceof InvalidOriginalAudioError) {
      throw new InvalidOriginalAudioError(
        `原声音频连续 ${AUDIO_UPLOAD_ATTEMPTS} 次上传后仍无法解码。`,
        { cause: error.cause },
      );
    }
    throw error;
  }
}

async function assertUsableOriginalAudio(
  objectKey: string,
  expectedSizeBytes?: number,
): Promise<void> {
  const stored = await getOssObjectInfo(objectKey);
  if (!stored?.contentLength) {
    throw new InvalidOriginalAudioError("OSS 原声音频不存在或为空。");
  }
  if (expectedSizeBytes !== undefined && stored.contentLength !== expectedSizeBytes) {
    throw new InvalidOriginalAudioError(
      `OSS 原声音频长度不一致：expected ${expectedSizeBytes}, received ${stored.contentLength}`,
    );
  }
  try {
    await probeTranscribableAudioFromUrl(createOssSignedUrl(objectKey));
  } catch (error) {
    throw new InvalidOriginalAudioError("OSS 原声音频无法解码。", { cause: error });
  }
}

async function ensureCompletedVideo(
  objectKey: string,
  videoUrls: readonly string[],
): Promise<CompletedVideo> {
  const cached = await getOssObjectInfo(objectKey);
  return downloadVideoWithResume(cached, objectKey, videoUrls);
}

async function uploadBuffer(
  body: Uint8Array,
  objectKey: string,
  contentType: string,
): Promise<void> {
  await putOssStream({
    body: Readable.toWeb(Readable.from([body])) as ReadableStream<Uint8Array>,
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    contentLength: body.byteLength,
    contentType,
    objectKey,
  });
}

async function uploadAudioFromVideo(
  videoBody: Uint8Array,
  objectKey: string,
  durationSeconds?: number,
): Promise<OriginalAudioAsset> {
  const audio = await createTranscribableAudioFileFromNode(Readable.from([videoBody]));
  try {
    await putOssStream({
      body: Readable.toWeb(createReadStream(audio.filePath)) as ReadableStream<Uint8Array>,
      cacheControl: REVALIDATED_CACHE_CONTROL,
      contentLength: audio.sizeBytes,
      contentType: audio.contentType,
      objectKey,
    });
    return {
      contentType: audio.contentType,
      durationSeconds: durationSeconds ?? audio.durationSeconds,
      objectKey,
      sizeBytes: audio.sizeBytes,
    };
  } finally {
    await audio.cleanup();
  }
}

async function downloadVideoWithResume(
  videoInfo: { contentType: string } | null,
  videoKey: string,
  videoUrls: readonly string[],
): Promise<CompletedVideo> {
  const chunks: Uint8Array[] = [];
  const clearChunks = () => {
    for (const chunk of chunks) chunk.fill(0);
    chunks.length = 0;
  };
  let size = 0;
  let contentType = videoInfo?.contentType || "video/mp4";

  try {
    return await retryOperation(async () => {
      let response: Response | undefined;
      try {
        const range = size ? `bytes=${size}-` : undefined;
        response = videoInfo
          ? await fetch(createOssSignedUrl(videoKey), range ? { headers: { range } } : undefined)
          : await fetchRemoteMedia(videoUrls, { range });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        contentType = videoInfo?.contentType || response.headers.get("content-type") || contentType;
        if (size && response.status !== 206) {
          clearChunks();
          size = 0;
        }

        const reader = response.body.getReader();
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            if (part.value?.byteLength) {
              chunks.push(part.value);
              size += part.value.byteLength;
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (!size) throw new Error("作品视频为空。");
        const body = new Uint8Array(size);
        let cursor = 0;
        for (const chunk of chunks) {
          body.set(chunk, cursor);
          cursor += chunk.byteLength;
        }
        clearChunks();
        return { body, contentType };
      } catch (error) {
        await response?.body?.cancel().catch(() => undefined);
        throw error;
      }
    }, { shouldRetry: isRetryableNetworkError });
  } finally {
    clearChunks();
  }
}

async function retryOssUpload<T>(operation: () => Promise<T>): Promise<T> {
  return await retryOperation(operation, { shouldRetry: isRetryableNetworkError });
}

function fromOssInfo(
  objectKey: string,
  info: { contentLength: number; contentType: string },
  fallbackType: string,
): StoredAsset {
  return {
    contentType: info.contentType || fallbackType,
    objectKey,
    sizeBytes: info.contentLength,
  };
}

function bundlePrefix(kind: DouyinKind, id: string): string {
  return `echolens/media/${kind}/${id}/`;
}

function clearStrings(values: string[]): void {
  values.fill("");
  values.length = 0;
}

