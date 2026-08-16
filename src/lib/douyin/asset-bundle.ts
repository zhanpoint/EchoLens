import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { DouyinWorkMetadata } from "@/lib/douyin/detail";
import {
  isRetryableNetworkError,
  retryOperation,
} from "@/lib/http/retry";
import {
  createTranscribableAudioFileFromNode,
  fetchRemoteMedia,
  probeTranscribableAudioFromUrl,
} from "@/lib/media/audio";
import { createOssSignedUrl, deleteOssObjects, getOssObjectInfo, putOssStream } from "@/lib/oss/object-store";
import type { DownloadVideoQuality } from "@/lib/download-settings";
import type { DouyinKind } from "@/types/douyin";

export type StoredAsset = { contentType: string; objectKey: string; sizeBytes: number };
export type OriginalAudioAsset = StoredAsset & { durationSeconds: number };

type AssetInput = { id: string; kind: DouyinKind; videoQuality?: DownloadVideoQuality };

const REVALIDATED_CACHE_CONTROL = "no-cache";
const ASR_AUDIO_OBJECT_NAME = "audio.m4a";
const AUDIO_UPLOAD_ATTEMPTS = 5;

class InvalidOriginalAudioError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidOriginalAudioError";
  }
}

export function douyinOriginalAudioObjectKey(input: Pick<AssetInput, "id" | "kind">): string {
  return `${bundlePrefix(input.kind, input.id)}${ASR_AUDIO_OBJECT_NAME}`;
}

export async function prepareDouyinOriginalAudio(
  input: AssetInput,
  metadata: DouyinWorkMetadata,
): Promise<OriginalAudioAsset> {
  const objectKey = douyinOriginalAudioObjectKey(input);
  return await ensureOriginalAudioFromSources(
    objectKey,
    metadata.audioUrls ?? [],
    metadata.videoUrls ?? [],
    metadata.durationSeconds,
  );
}

async function ensureOriginalAudioFromSources(
  objectKey: string,
  audioUrls: readonly string[],
  videoUrls: readonly string[],
  durationSeconds?: number,
): Promise<OriginalAudioAsset> {
  const existing = await getOssObjectInfo(objectKey);
  if (existing?.contentLength) {
    return {
      contentType: existing.contentType || "audio/mp4",
      durationSeconds: durationSeconds ?? 0,
      objectKey,
      sizeBytes: existing.contentLength,
    };
  }

  if (audioUrls.length) {
    try {
      return await uploadDirectAudio(objectKey, audioUrls, durationSeconds);
    } catch {
      await deleteOssObjects([objectKey]);
    }
  }
  return await extractAndUploadAudio(objectKey, videoUrls, durationSeconds);
}

async function uploadDirectAudio(
  objectKey: string,
  audioUrls: readonly string[],
  durationSeconds?: number,
): Promise<OriginalAudioAsset> {
  return await retryOperation(async () => {
    const response = await fetchRemoteMedia(audioUrls, { mediaSource: "douyin" });
    try {
      await putOssStream({
        body: response.body!,
        cacheControl: REVALIDATED_CACHE_CONTROL,
        contentLength: positiveContentLength(response),
        contentType: response.headers.get("content-type") || "audio/mp4",
        objectKey,
      });
      const stored = await requireStoredAudio(objectKey);
      await probeTranscribableAudioFromUrl(createOssSignedUrl(objectKey));
      return {
        contentType: stored.contentType || "audio/mp4",
        durationSeconds: durationSeconds ?? 0,
        objectKey,
        sizeBytes: stored.contentLength,
      };
    } catch (error) {
      await deleteOssObjects([objectKey]);
      throw error;
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  }, {
    attempts: AUDIO_UPLOAD_ATTEMPTS,
    shouldRetry: (error) => error instanceof InvalidOriginalAudioError || isRetryableNetworkError(error),
  });
}

async function extractAndUploadAudio(
  objectKey: string,
  videoUrls: readonly string[],
  durationSeconds?: number,
): Promise<OriginalAudioAsset> {
  const response = await fetchRemoteMedia(videoUrls, { mediaSource: "douyin" });
  let audio: Awaited<ReturnType<typeof createTranscribableAudioFileFromNode>> | undefined;
  try {
    audio = await createTranscribableAudioFileFromNode(
      Readable.fromWeb(response.body! as import("node:stream/web").ReadableStream<Uint8Array>),
    );
    await retryOperation(async () => {
      try {
        await putOssStream({
          body: Readable.toWeb(createReadStream(audio!.filePath)) as ReadableStream<Uint8Array>,
          cacheControl: REVALIDATED_CACHE_CONTROL,
          contentLength: audio!.sizeBytes,
          contentType: audio!.contentType,
          objectKey,
        });
        const stored = await requireStoredAudio(objectKey);
        if (stored.contentLength !== audio!.sizeBytes) {
          throw new InvalidOriginalAudioError("OSS 原声音频长度不一致。");
        }
        await probeTranscribableAudioFromUrl(createOssSignedUrl(objectKey));
      } catch (error) {
        await deleteOssObjects([objectKey]);
        throw error;
      }
    }, {
      attempts: AUDIO_UPLOAD_ATTEMPTS,
      shouldRetry: (error) => error instanceof InvalidOriginalAudioError || isRetryableNetworkError(error),
    });
    return {
      contentType: audio.contentType,
      durationSeconds: durationSeconds ?? audio.durationSeconds,
      objectKey,
      sizeBytes: audio.sizeBytes,
    };
  } finally {
    await response.body?.cancel().catch(() => undefined);
    await audio?.cleanup();
  }
}

async function requireStoredAudio(objectKey: string) {
  const stored = await getOssObjectInfo(objectKey);
  if (!stored?.contentLength) throw new InvalidOriginalAudioError("OSS 原声音频不存在或为空。");
  return stored;
}

function positiveContentLength(response: Response): number | undefined {
  const value = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function bundlePrefix(kind: DouyinKind, id: string): string {
  return `echolens/media/${kind}/${id}/`;
}