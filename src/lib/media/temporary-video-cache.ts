import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { fetchRemoteMedia, muxVideoAndAudioToFile, type MediaSourcePlatform } from "@/lib/media/audio";

type CacheEntry = {
  cleanup: () => Promise<void>;
  expiresAt: number;
  filePath: string;
  lastAccessedAt: number;
  references: number;
  sizeBytes: number;
};

type GlobalTemporaryVideoCache = typeof globalThis & {
  __echolensTemporaryVideoCache?: Map<string, CacheEntry>;
  __echolensTemporaryVideoTasks?: Map<string, Promise<CacheEntry>>;
  __echolensTemporaryVideoTimer?: ReturnType<typeof setInterval>;
};

export type TemporaryVideoLease = {
  expiresAt: number;
  filePath: string;
  release: () => void;
  sizeBytes: number;
};

const globalCache = globalThis as GlobalTemporaryVideoCache;
const entries = globalCache.__echolensTemporaryVideoCache ??= new Map();
const tasks = globalCache.__echolensTemporaryVideoTasks ??= new Map();
const TTL_MS = 15 * 60_000;
const MAX_ENTRIES = readPositiveInteger("TEMP_VIDEO_CACHE_MAX_ENTRIES", 32);
const MAX_BYTES = readPositiveInteger("TEMP_VIDEO_CACHE_MAX_BYTES", 4 * 1024 * 1024 * 1024);
const MAX_FILE_BYTES = readPositiveInteger("TEMP_VIDEO_MAX_FILE_BYTES", 1024 * 1024 * 1024);
const MAX_CONCURRENT_MUXES = readPositiveInteger("TEMP_VIDEO_MAX_CONCURRENT_MUXES", 2);
const MAX_MUX_QUEUE = readPositiveInteger("TEMP_VIDEO_MAX_MUX_QUEUE", 128);
let activeMuxes = 0;
const muxWaiters: Array<() => void> = [];

if (!globalCache.__echolensTemporaryVideoTimer) {
  globalCache.__echolensTemporaryVideoTimer = setInterval(() => void sweepTemporaryVideos(), 60_000);
  globalCache.__echolensTemporaryVideoTimer.unref?.();
}

export function temporaryVideoCacheKey(cacheIdentity: string): string {
  return createHash("sha256").update(cacheIdentity).digest("hex").slice(0, 32);
}

export async function ensureTemporaryMuxedVideo(input: {
  audioUrls: readonly string[];
  cacheIdentity: string;
  mediaSource: MediaSourcePlatform;
  videoUrls: readonly string[];
}): Promise<{ cacheKey: string; expiresAt: number; sizeBytes: number }> {
  const cacheKey = temporaryVideoCacheKey(input.cacheIdentity);
  const reusable = entries.get(cacheKey);
  if (reusable && reusable.expiresAt > Date.now() && await fileStillExists(reusable)) {
    touch(reusable);
    return { cacheKey, expiresAt: reusable.expiresAt, sizeBytes: reusable.sizeBytes };
  }
  if (reusable) await removeEntry(cacheKey, reusable);

  let task = tasks.get(cacheKey);
  if (!task) {
    task = createEntry(input.videoUrls, input.audioUrls, input.mediaSource);
    tasks.set(cacheKey, task);
    void task.finally(() => tasks.delete(cacheKey)).catch(() => undefined);
  }
  const created = await task;
  if (created.sizeBytes > MAX_FILE_BYTES) {
    await created.cleanup().catch(() => undefined);
    throw new Error("临时视频超过单文件缓存上限。");
  }
  entries.set(cacheKey, created);
  await enforceLimits(cacheKey);
  return { cacheKey, expiresAt: created.expiresAt, sizeBytes: created.sizeBytes };
}

export async function acquireTemporaryVideo(cacheKey: string): Promise<TemporaryVideoLease | null> {
  const entry = entries.get(cacheKey);
  if (!entry || entry.expiresAt <= Date.now() || !await fileStillExists(entry)) {
    if (entry) await removeEntry(cacheKey, entry);
    return null;
  }
  entry.references += 1;
  touch(entry);
  let released = false;
  return {
    expiresAt: entry.expiresAt,
    filePath: entry.filePath,
    release() {
      if (released) return;
      released = true;
      entry.references = Math.max(0, entry.references - 1);
      touch(entry);
    },
    sizeBytes: entry.sizeBytes,
  };
}

async function createEntry(
  videoUrls: readonly string[],
  audioUrls: readonly string[],
  mediaSource: MediaSourcePlatform,
): Promise<CacheEntry> {
  await acquireMuxSlot();
  try {
    return await createEntryUnbounded(videoUrls, audioUrls, mediaSource);
  } finally {
    releaseMuxSlot();
  }
}

async function createEntryUnbounded(
  videoUrls: readonly string[],
  audioUrls: readonly string[],
  mediaSource: MediaSourcePlatform,
): Promise<CacheEntry> {
  const [video, audio] = await Promise.all([
    fetchRemoteMedia(videoUrls, { mediaSource }),
    fetchRemoteMedia(audioUrls, { mediaSource }),
  ]);
  try {
    const declaredBytes = [video, audio]
      .map((response) => Number(response.headers.get("content-length")) || 0)
      .reduce((total, value) => total + value, 0);
    if (declaredBytes > MAX_FILE_BYTES * 2) {
      throw new Error("DASH 音视频输入超过临时缓存上限。");
    }
    const file = await muxVideoAndAudioToFile(
      Readable.fromWeb(video.body! as import("node:stream/web").ReadableStream<Uint8Array>),
      Readable.fromWeb(audio.body! as import("node:stream/web").ReadableStream<Uint8Array>),
      { maxAudioBytes: MAX_FILE_BYTES, maxVideoBytes: MAX_FILE_BYTES },
    );
    return {
      cleanup: file.cleanup,
      expiresAt: Date.now() + TTL_MS,
      filePath: file.filePath,
      lastAccessedAt: Date.now(),
      references: 0,
      sizeBytes: file.sizeBytes,
    };
  } finally {
    await Promise.allSettled([video.body?.cancel(), audio.body?.cancel()]);
  }
}

async function sweepTemporaryVideos(): Promise<void> {
  const now = Date.now();
  await Promise.all([...entries.entries()].map(async ([key, entry]) => {
    if (entry.references === 0 && entry.expiresAt <= now) await removeEntry(key, entry);
  }));
  await enforceLimits();
}

async function enforceLimits(protectedKey?: string): Promise<void> {
  let totalBytes = [...entries.values()].reduce((total, entry) => total + entry.sizeBytes, 0);
  const candidates = [...entries.entries()]
    .filter(([key, entry]) => key !== protectedKey && entry.references === 0)
    .sort(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);
  for (const [key, entry] of candidates) {
    if (entries.size <= MAX_ENTRIES && totalBytes <= MAX_BYTES) break;
    totalBytes -= entry.sizeBytes;
    await removeEntry(key, entry);
  }
}

async function removeEntry(key: string, entry: CacheEntry): Promise<void> {
  if (entry.references > 0 || entries.get(key) !== entry) return;
  entries.delete(key);
  await entry.cleanup().catch(() => undefined);
}

async function fileStillExists(entry: CacheEntry): Promise<boolean> {
  return await stat(entry.filePath).then((value) => value.size === entry.sizeBytes, () => false);
}

function touch(entry: CacheEntry): void {
  entry.lastAccessedAt = Date.now();
  entry.expiresAt = entry.lastAccessedAt + TTL_MS;
}

async function acquireMuxSlot(): Promise<void> {
  if (activeMuxes < MAX_CONCURRENT_MUXES) {
    activeMuxes += 1;
    return;
  }
  if (muxWaiters.length >= MAX_MUX_QUEUE) {
    throw new Error("临时视频处理队列已满，请稍后重试。");
  }
  await new Promise<void>((resolve) => muxWaiters.push(resolve));
}

function releaseMuxSlot(): void {
  const next = muxWaiters.shift();
  if (next) next();
  else activeMuxes = Math.max(0, activeMuxes - 1);
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}