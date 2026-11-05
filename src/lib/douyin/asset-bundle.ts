import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { DouyinWorkMetadata } from "@/lib/douyin/detail";
import {
  isRetryableNetworkError,
  retryOperation,
} from "@/lib/http/retry";
import {
  createTranscribableAudioFileFromNode,
  AudioUnavailableError,
  fetchRemoteMedia,
} from "@/lib/media/audio";
import { deleteOssObjects, getOssObjectInfo, putOssStream } from "@/lib/oss/object-store";
import type { DownloadVideoQuality } from "@/lib/download-settings";
import type { DouyinKind } from "@/types/douyin";

export type StoredAsset = { contentType: string; objectKey: string; sizeBytes: number };
export type OriginalAudioAsset = StoredAsset & { durationSeconds: number };

type AssetInput = { id: string; kind: DouyinKind; videoQuality?: DownloadVideoQuality };

const REVALIDATED_CACHE_CONTROL = "no-cache";
const ASR_AUDIO_OBJECT_NAME = "audio.m4a";
const AUDIO_UPLOAD_ATTEMPTS = 5;
const originalAudioTasks = new Map<string, Promise<OriginalAudioAsset>>();

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
  credentialCookie = "",
): Promise<OriginalAudioAsset> {
  const objectKey = douyinOriginalAudioObjectKey(input);
  const taskKey = `${objectKey}:${createHash("sha256").update(credentialCookie).digest("hex")}`;
  const existing = originalAudioTasks.get(taskKey);
  if (existing) return existing;
  const task = ensureOriginalAudioFromSources(
    objectKey,
    metadata.audioUrls ?? [],
    metadata.videoUrls ?? [],
    metadata.durationSeconds,
    credentialCookie,
  ).finally(() => originalAudioTasks.delete(taskKey));
  originalAudioTasks.set(taskKey, task);
  return task;
}

async function ensureOriginalAudioFromSources(
  objectKey: string,
  audioUrls: readonly string[],
  videoUrls: readonly string[],
  durationSeconds?: number,
  credentialCookie = "",
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
      return await extractAndUploadAudio(objectKey, audioUrls, durationSeconds, credentialCookie);
    } catch (error) {
      if (!videoUrls.length || isRetryableNetworkError(error)) throw error;
    }
  }
  if (!videoUrls.length) throw new AudioUnavailableError("作品没有可用的音频或视频资源。");
  return await extractAndUploadAudio(objectKey, videoUrls, durationSeconds, credentialCookie);
}

async function extractAndUploadAudio(
  objectKey: string,
  sourceUrls: readonly string[],
  durationSeconds?: number,
  credentialCookie = "",
): Promise<OriginalAudioAsset> {
  const response = await fetchRemoteMedia(sourceUrls, { mediaSource: "douyin", douyinCookie: credentialCookie });
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

function bundlePrefix(kind: DouyinKind, id: string): string {
  return `echolens/media/${kind}/${id}/`;
}
