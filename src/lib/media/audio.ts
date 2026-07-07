import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DOUYIN_REFERER = "https://www.douyin.com/";
const DOUYIN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const MEDIA_DOWNLOAD_TIMEOUT_MS = 600_000;
const MEDIA_DOWNLOAD_MAX_ATTEMPTS = 3;
const MEDIA_DOWNLOAD_RETRY_BASE_DELAY_MS = 500;
const FFMPEG_AUDIO_EXTRACT_TIMEOUT_MS = 600_000;
const FFMPEG_STDERR_TAIL_CHARS = 8_192;
const MAX_USER_MEDIA_CACHES = 256;
const MAX_TRANSCRIBE_AUDIO_DURATION_SECONDS = 12 * 60 * 60;
const MAX_TRANSCRIBE_AUDIO_BYTES = 2 * 1024 * 1024 * 1024;
const AUDIO_DURATION_LIMIT_MESSAGE = "音频时长不能超过 12 小时，暂不能提取。";
const AUDIO_DURATION_READ_MESSAGE = "无法识别缓存音频时长，请重新缓存后再提取。";
const AUDIO_SIZE_LIMIT_MESSAGE = "转写的音频大小不能超过 2GB，暂不能提取。";

export type RemoteMediaSource = string | readonly string[];
export type CachedRemoteMedia = {
  contentType?: string;
  filePath: string;
};
export type AudioTranscriptionLimits = {
  durationLimitMessage?: string;
  maxBytes: number;
  maxDurationSeconds: number;
  sizeLimitMessage?: string;
};
export type TranscribableAudio = {
  contentType: string;
  durationSeconds: number;
  extension: string;
  filePath: string;
  sizeBytes: number;
};

export class AudioTranscriptionLimitError extends Error {}
export class CompletedMediaCacheRequiredError extends Error {}
class RangeResumeUnsupportedError extends Error {}

type CachedRemoteMediaEntry = CachedRemoteMedia & {
  lastAccessedAt: number;
};
type AudioFileMetadata = {
  contentType: string;
  durationSeconds: number;
  extension: string;
  filePath: string;
};
type CachedAudioEntry = AudioFileMetadata & {
  lastAccessedAt: number;
};
type UserMediaCache = {
  activeCacheRunId: string | null;
  activeWorkKey: string | null;
  extractedAudio: Map<string, CachedAudioEntry>;
  extractedAudioTasks: Map<string, Promise<CachedAudioEntry>>;
  lastAccessedAt: number;
  remoteMedia: Map<string, CachedRemoteMediaEntry>;
  remoteMediaTasks: Map<string, Promise<CachedRemoteMediaEntry>>;
  taskController: AbortController;
};
type AbortableOptions = {
  signal?: AbortSignal;
};
type MediaCacheOptions = AbortableOptions & {
  cacheKey?: string;
};

const userMediaCaches = new Map<string, UserMediaCache>();
const EXTRACTED_AUDIO_CONTENT_TYPE = "audio/mp4";
const EXTRACTED_AUDIO_EXTENSION = "m4a";

export function resolveBundledFfmpegPath(): string {
  return path.join(
    process.cwd(),
    "node_modules",
    "@ffmpeg-installer",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
}

export async function prepareMediaCacheForWork(userId: string, workKey: string, cacheRunId?: string): Promise<void> {
  const cache = await readUserMediaCache(userId);
  const nextWorkKey = workKey.trim();
  const hasRunId = cacheRunId !== undefined;
  const nextRunId = cacheRunId?.trim() || null;
  if (!nextWorkKey) {
    return;
  }
  if (cache.activeWorkKey === nextWorkKey) {
    if (hasRunId) {
      cache.activeCacheRunId = nextRunId;
    }
    return;
  }

  const isDifferentWork = cache.activeWorkKey !== null && cache.activeWorkKey !== nextWorkKey;
  if (isDifferentWork) {
    cache.taskController.abort();
    cache.taskController = new AbortController();
  }
  cache.activeWorkKey = nextWorkKey;
  cache.activeCacheRunId = nextRunId;
  if (isDifferentWork) {
    cache.remoteMediaTasks.clear();
    cache.extractedAudioTasks.clear();
    await Promise.all([
      clearCachedFiles(cache.remoteMedia),
      clearCachedFiles(cache.extractedAudio),
    ]);
  }
}

async function extractAudioToCachedFile(
  userId: string,
  mediaCacheKey: string,
  options: AbortableOptions = {},
): Promise<CachedAudioEntry> {
  const cache = await readUserMediaCache(userId);
  const normalizedMediaCacheKey = mediaCacheKey.trim();
  const signal = linkedAbortSignal(cache.taskController.signal, options.signal);
  throwIfAborted(signal);
  if (!normalizedMediaCacheKey) {
    throw new Error("媒体缓存标识无效。");
  }

  const storageKey = buildStableRemoteMediaCacheKey(userId, normalizedMediaCacheKey);
  const cached = cache.extractedAudio.get(storageKey);
  if (cached && (await readFileSize(cached.filePath)) > 0) {
    cached.lastAccessedAt = Date.now();
    return cached;
  }
  cache.extractedAudio.delete(storageKey);

  const inflight = cache.extractedAudioTasks.get(storageKey);
  if (inflight) {
    return inflight;
  }

  const task = cacheExtractedAudioFile(storageKey, cache, signal).finally(() => {
    if (cache.extractedAudioTasks.get(storageKey) === task) {
      cache.extractedAudioTasks.delete(storageKey);
    }
  });
  cache.extractedAudioTasks.set(storageKey, task);
  return task;
}

export async function downloadRemoteMediaToFile(
  source: RemoteMediaSource,
  outputPath: string,
  options: AbortableOptions = {},
): Promise<string | undefined> {
  let lastError: unknown;
  const urls = normalizeRemoteMediaSource(source);
  throwIfAborted(options.signal);
  if (urls.length === 0) {
    throw new Error("媒体资源地址无效。");
  }

  for (let urlIndex = 0; urlIndex < urls.length; urlIndex += 1) {
    throwIfAborted(options.signal);
    const url = urls[urlIndex];
    if (urlIndex > 0) {
      await fs.rm(outputPath, { force: true });
    }

    for (let attempt = 1; attempt <= MEDIA_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
      const offset = await readFileSize(outputPath);

      try {
        const result = await downloadMediaRange(url, outputPath, offset, options.signal);
        const downloadedSize = await readFileSize(outputPath);
        if (result.totalSize === null || downloadedSize >= result.totalSize) {
          return result.contentType;
        }

        lastError = new Error(`下载不完整：${downloadedSize}/${result.totalSize}`);
      } catch (error) {
        lastError = error;
        if (error instanceof RangeResumeUnsupportedError) {
          try {
            const result = await downloadMediaRange(url, outputPath, 0, options.signal);
            const downloadedSize = await readFileSize(outputPath);
            if (result.totalSize === null || downloadedSize >= result.totalSize) {
              return result.contentType;
            }

            lastError = new Error(`下载不完整：${downloadedSize}/${result.totalSize}`);
          } catch (restartError) {
            lastError = restartError;
          }
        }
        if (!isRetryableMediaDownloadError(lastError)) {
          break;
        }
      }

      if (attempt < MEDIA_DOWNLOAD_MAX_ATTEMPTS) {
        await delay(exponentialDelay(attempt, MEDIA_DOWNLOAD_RETRY_BASE_DELAY_MS, 5_000), options.signal);
      }
    }

  }

  if (lastError instanceof Error && lastError.name === "AbortError") {
    throw lastError;
  }
  throw new Error(`媒体资源下载失败：${lastError instanceof Error ? lastError.message : "未知错误"}`);
}

function isRetryableMediaDownloadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }
  if (error.name === "AbortError") {
    return false;
  }

  const httpStatus = error.message.match(/\bHTTP (\d{3})\b/)?.[1];
  if (httpStatus) {
    const status = Number(httpStatus);
    return status === 429 || status >= 500;
  }

  return /超时|fetch failed|network|socket|timeout|timed out|premature close|terminated|UND_ERR|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/i.test(error.message);
}

function exponentialDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const jitter = Math.floor(Math.random() * Math.min(baseDelayMs, 250));
  return Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1) + jitter, maxDelayMs);
}

export async function downloadRemoteMediaToCachedFile(
  userId: string,
  source: RemoteMediaSource,
  options: MediaCacheOptions = {},
): Promise<CachedRemoteMedia> {
  const cache = await readUserMediaCache(userId);
  const urls = normalizeRemoteMediaSource(source);
  const signal = linkedAbortSignal(cache.taskController.signal, options.signal);
  throwIfAborted(signal);
  if (urls.length === 0) {
    throw new Error("媒体资源地址无效。");
  }

  const cacheKey = buildRemoteMediaCacheKey(userId, urls, options.cacheKey);
  const cached = await readCompletedRemoteMediaCache(cache, cacheKey);
  if (cached) {
    return cached;
  }

  const inflight = cache.remoteMediaTasks.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const task = cacheRemoteMediaFile(cacheKey, urls, cache, signal).finally(() => {
    if (cache.remoteMediaTasks.get(cacheKey) === task) {
      cache.remoteMediaTasks.delete(cacheKey);
    }
  });
  cache.remoteMediaTasks.set(cacheKey, task);
  return task;
}

async function downloadMediaRange(
  url: string,
  outputPath: string,
  offset: number,
  signal?: AbortSignal,
): Promise<{ contentType?: string; totalSize: number | null }> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);
  const fetchSignal = linkedAbortSignal(timeoutController.signal, signal);

  try {
    const response = await fetch(url, {
      signal: fetchSignal,
      headers: {
        ...mediaDownloadHeaders(),
        ...(offset > 0 ? { range: `bytes=${offset}-` } : {}),
      },
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (offset > 0 && response.status !== 206) {
      await response.body.cancel();
      await fs.rm(outputPath, { force: true });
      throw new RangeResumeUnsupportedError("服务器不支持断点续传，已重新完整下载。");
    }

    await pipeline(
      Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(outputPath, { flags: offset > 0 ? "a" : "w" }),
    );

    return {
      contentType: response.headers.get("content-type") ?? undefined,
      totalSize: readTotalSize(response, offset),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw signal?.aborted ? abortError() : new Error("媒体资源下载超时，请稍后重试或改用更短的视频。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readTotalSize(response: Response, offset: number): number | null {
  const contentRange = response.headers.get("content-range");
  const totalFromRange = contentRange?.match(/\/(\d+)$/)?.[1];
  if (totalFromRange) {
    const total = Number(totalFromRange);
    return Number.isFinite(total) && total > 0 ? total : null;
  }

  const contentLength = Number(response.headers.get("content-length"));
  return Number.isFinite(contentLength) && contentLength > 0 ? offset + contentLength : null;
}

async function readFileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function normalizeRemoteMediaSource(source: RemoteMediaSource): string[] {
  const urls = Array.isArray(source) ? source : [source];
  return Array.from(
    new Set(
      urls
        .map((url) => url.trim())
        .filter((url) => url.startsWith("https://") || url.startsWith("http://")),
    ),
  );
}

async function cacheRemoteMediaFile(
  cacheKey: string,
  urls: string[],
  cache: UserMediaCache,
  signal: AbortSignal,
): Promise<CachedRemoteMediaEntry> {
  const cacheDir = path.join(os.tmpdir(), "echolens-media-cache");
  const filePath = path.join(cacheDir, `${cacheKey}.media`);
  const partialPath = buildTaskPartialPath(filePath);
  await fs.mkdir(cacheDir, { recursive: true });

  try {
    const contentType = await downloadRemoteMediaToFile(urls, partialPath, { signal });
    throwIfAborted(signal);
    await fs.rm(filePath, { force: true });
    await fs.rename(partialPath, filePath);

    const entry = {
      contentType,
      filePath,
      lastAccessedAt: Date.now(),
    };
    cache.remoteMedia.set(cacheKey, entry);
    return entry;
  } catch (error) {
    await fs.rm(partialPath, { force: true });
    throw error;
  }
}

async function readCompletedRemoteMediaCache(
  cache: UserMediaCache,
  cacheKey: string,
): Promise<CachedRemoteMediaEntry | null> {
  const cached = cache.remoteMedia.get(cacheKey);
  if (cached && (await readFileSize(cached.filePath)) > 0) {
    cached.lastAccessedAt = Date.now();
    return cached;
  }

  cache.remoteMedia.delete(cacheKey);
  return null;
}

async function readRequiredCompletedRemoteMediaCache(
  cache: UserMediaCache,
  cacheKey: string,
): Promise<CachedRemoteMediaEntry> {
  const cached = await readCompletedRemoteMediaCache(cache, cacheKey);
  if (cached) {
    return cached;
  }

  const inflight = cache.remoteMediaTasks.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  throw new CompletedMediaCacheRequiredError("完整视频缓存未就绪，请先完成视频缓存后再转录。");
}

async function cacheExtractedAudioFile(
  cacheKey: string,
  cache: UserMediaCache,
  signal: AbortSignal,
): Promise<CachedAudioEntry> {
  const media = await readRequiredCompletedRemoteMediaCache(cache, cacheKey);
  throwIfAborted(signal);
  const cacheDir = path.join(os.tmpdir(), "echolens-audio-cache");
  await fs.mkdir(cacheDir, { recursive: true });

  const audio = await extractAudioToM4a(media.filePath, cacheDir, cacheKey, signal);

  const entry = {
    contentType: audio.contentType,
    durationSeconds: audio.durationSeconds,
    extension: audio.extension,
    filePath: audio.filePath,
    lastAccessedAt: Date.now(),
  };
  cache.extractedAudio.set(cacheKey, entry);
  return entry;
}

async function extractAudioToM4a(
  inputPath: string,
  outputDir: string,
  cacheKey: string,
  signal: AbortSignal,
): Promise<AudioFileMetadata> {
  const filePath = path.join(outputDir, `${cacheKey}.${EXTRACTED_AUDIO_EXTENSION}`);
  const partialPath = buildTaskPartialPath(filePath);
  await fs.rm(partialPath, { force: true });

  try {
    const durationSeconds = await runFfmpeg(resolveFfmpegPath(), m4aExtractArgs(inputPath, partialPath), signal);
    throwIfAborted(signal);
    const size = await readFileSize(partialPath);
    if (size <= 0) {
      throw new Error("ffmpeg 抽取音频失败：输出文件为空。");
    }
    await fs.rm(filePath, { force: true });
    await fs.rename(partialPath, filePath);
    return {
      contentType: EXTRACTED_AUDIO_CONTENT_TYPE,
      durationSeconds,
      extension: EXTRACTED_AUDIO_EXTENSION,
      filePath,
    };
  } catch (error) {
    await fs.rm(partialPath, { force: true });
    throw error;
  }
}

function m4aExtractArgs(inputPath: string, outputPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    "-progress",
    "pipe:2",
    "-nostats",
    outputPath,
  ];
}

export async function prepareTranscribableAudioFromCachedMedia(
  userId: string,
  mediaCacheKey: string,
  limits: AudioTranscriptionLimits = {
    maxBytes: MAX_TRANSCRIBE_AUDIO_BYTES,
    maxDurationSeconds: MAX_TRANSCRIBE_AUDIO_DURATION_SECONDS,
  },
  options: AbortableOptions = {},
): Promise<TranscribableAudio> {
  const audio = await extractAudioToCachedFile(userId, mediaCacheKey, options);
  throwIfAborted(options.signal);
  const size = await readFileSize(audio.filePath);
  if (size > limits.maxBytes) {
    throw new AudioTranscriptionLimitError(limits.sizeLimitMessage ?? AUDIO_SIZE_LIMIT_MESSAGE);
  }

  const durationSeconds = audio.durationSeconds;
  throwIfAborted(options.signal);
  if (durationSeconds > limits.maxDurationSeconds) {
    throw new AudioTranscriptionLimitError(limits.durationLimitMessage ?? AUDIO_DURATION_LIMIT_MESSAGE);
  }

  return {
    contentType: audio.contentType,
    durationSeconds,
    extension: audio.extension,
    filePath: audio.filePath,
    sizeBytes: size,
  };
}

async function clearCachedFiles(entries: Map<string, { filePath: string }>): Promise<void> {
  const paths = [...entries.values()].map((entry) => entry.filePath);
  entries.clear();
  await Promise.all(paths.map((filePath) => fs.rm(filePath, { force: true })));
}

async function readUserMediaCache(userId: string): Promise<UserMediaCache> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("用户身份无效。");
  }

  const existing = userMediaCaches.get(normalizedUserId);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    return existing;
  }

  const cache: UserMediaCache = {
    activeCacheRunId: null,
    activeWorkKey: null,
    extractedAudio: new Map(),
    extractedAudioTasks: new Map(),
    lastAccessedAt: Date.now(),
    remoteMedia: new Map(),
    remoteMediaTasks: new Map(),
    taskController: new AbortController(),
  };
  userMediaCaches.set(normalizedUserId, cache);
  await trimUserMediaCaches(normalizedUserId);
  return cache;
}

async function trimUserMediaCaches(activeUserId: string): Promise<void> {
  if (userMediaCaches.size <= MAX_USER_MEDIA_CACHES) {
    return;
  }

  const overflow = userMediaCaches.size - MAX_USER_MEDIA_CACHES;
  const staleUsers = [...userMediaCaches.entries()]
    .filter(([userId]) => userId !== activeUserId)
    .sort(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt)
    .slice(0, overflow);

  await Promise.all(staleUsers.map(([userId, cache]) => deleteUserMediaCache(userId, cache)));
}

async function deleteUserMediaCache(userId: string, cache: UserMediaCache): Promise<void> {
  cache.taskController.abort();
  cache.remoteMediaTasks.clear();
  cache.extractedAudioTasks.clear();
  await Promise.all([
    clearCachedFiles(cache.remoteMedia),
    clearCachedFiles(cache.extractedAudio),
  ]);
  userMediaCaches.delete(userId);
}

function buildRemoteMediaCacheKey(userId: string, urls: string[], cacheKey?: string): string {
  return cacheKey
    ? buildStableRemoteMediaCacheKey(userId, cacheKey)
    : createHash("sha256").update(JSON.stringify([userId, urls])).digest("hex");
}

function buildStableRemoteMediaCacheKey(userId: string, cacheKey: string): string {
  return createHash("sha256").update(JSON.stringify([userId, "stable", cacheKey])).digest("hex");
}

function buildTaskPartialPath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.part`;
}

function mediaDownloadHeaders(): Record<string, string> {
  return {
    accept: "video/mp4,audio/*,*/*;q=0.8",
    referer: DOUYIN_REFERER,
    "user-agent": DOUYIN_USER_AGENT,
  };
}

function runFfmpeg(ffmpegPath: string, args: string[], signal?: AbortSignal): Promise<number> {
  let stderr = "";
  let maxDurationSeconds = 0;
  throwIfAborted(signal);

  return new Promise<number>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      signal?.removeEventListener("abort", abort);
      reject(new Error("ffmpeg 抽取音频超时，请稍后重试或改用更短的视频。"));
    }, FFMPEG_AUDIO_EXTRACT_TIMEOUT_MS);
    const abort = () => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = tailText(`${stderr}${chunk}`, FFMPEG_STDERR_TAIL_CHARS);
      maxDurationSeconds = Math.max(maxDurationSeconds, parseFfmpegProgressDurationSeconds(stderr));
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      if (code === 0) {
        if (maxDurationSeconds > 0) {
          resolve(maxDurationSeconds);
          return;
        }
        reject(new Error(AUDIO_DURATION_READ_MESSAGE));
        return;
      }

      reject(new Error(`ffmpeg 抽取音频失败：${stderr.slice(-600)}`));
    });
  });
}

function parseFfmpegProgressDurationSeconds(chunk: string): number {
  let maxSeconds = 0;
  for (const line of chunk.split(/\r?\n/u)) {
    const outTime = line.match(/^out_time=(\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)$/u);
    if (outTime) {
      maxSeconds = Math.max(
        maxSeconds,
        Number(outTime[1]) * 3600 + Number(outTime[2]) * 60 + Number(outTime[3]),
      );
      continue;
    }

    const outTimeMs = line.match(/^out_time_ms=(\d+)$/u);
    if (outTimeMs) {
      maxSeconds = Math.max(maxSeconds, Number(outTimeMs[1]) / 1_000_000);
    }
  }

  return Number.isFinite(maxSeconds) ? maxSeconds : 0;
}

function tailText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function linkedAbortSignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }

  const controller = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function abortError(): Error {
  const error = new Error("缓存任务已取消。");
  error.name = "AbortError";
  return error;
}

export function resolveFfmpegPath(): string {
  const configuredPath = process.env.FFMPEG_PATH?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  return resolveBundledFfmpegPath();
}
