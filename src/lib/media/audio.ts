import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000;
const MEDIA_DOWNLOAD_MAX_ATTEMPTS = 3;
const DEFAULT_MP3_CHUNK_SECONDS = 300;
const MAX_USER_MEDIA_CACHES = 256;

export type RemoteMediaSource = string | readonly string[];
export type DownloadedRemoteMedia = {
  buffer: Buffer;
  contentType?: string;
};
export type CachedRemoteMedia = {
  contentType?: string;
  filePath: string;
};

export type AudioChunk = {
  buffer: Buffer;
  endSeconds: number;
  format: "mp3";
  startSeconds: number;
};

type CachedRemoteMediaEntry = CachedRemoteMedia & {
  lastAccessedAt: number;
};
type CachedAudioEntry = {
  filePath: string;
  lastAccessedAt: number;
};
type UserMediaCache = {
  activeWorkKey: string | null;
  extractedAudio: Map<string, CachedAudioEntry>;
  extractedAudioTasks: Map<string, Promise<CachedAudioEntry>>;
  generation: number;
  lastAccessedAt: number;
  remoteMedia: Map<string, CachedRemoteMediaEntry>;
  remoteMediaTasks: Map<string, Promise<CachedRemoteMediaEntry>>;
};

const userMediaCaches = new Map<string, UserMediaCache>();

export function resolveBundledFfmpegPath(): string {
  return path.join(
    process.cwd(),
    "node_modules",
    "@ffmpeg-installer",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
}

export async function normalizeAudioToWav(userId: string, source: RemoteMediaSource): Promise<Buffer> {
  const audio = await extractAudioToCachedWav(userId, source);
  return await fs.readFile(audio.filePath);
}

export async function prepareMediaCacheForWork(userId: string, workKey: string): Promise<void> {
  const cache = await readUserMediaCache(userId);
  const nextWorkKey = workKey.trim();
  if (!nextWorkKey || cache.activeWorkKey === nextWorkKey) {
    return;
  }

  cache.activeWorkKey = nextWorkKey;
  cache.generation += 1;
  cache.remoteMediaTasks.clear();
  cache.extractedAudioTasks.clear();
  await Promise.all([
    clearCachedFiles(cache.remoteMedia),
    clearCachedFiles(cache.extractedAudio),
  ]);
}

export async function transcodeAudioToMp3Chunks(
  userId: string,
  source: RemoteMediaSource,
  chunkSeconds = DEFAULT_MP3_CHUNK_SECONDS,
): Promise<AudioChunk[]> {
  const ffmpegPath = resolveFfmpegPath();
  const audio = await extractAudioToCachedWav(userId, source);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-transcript-"));
  const outputPattern = path.join(tempDir, "chunk-%03d.mp3");

  try {
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-i",
      audio.filePath,
      "-acodec",
      "libmp3lame",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "48k",
      "-f",
      "segment",
      "-segment_time",
      String(chunkSeconds),
      "-reset_timestamps",
      "1",
      outputPattern,
    ]);

    const files = (await fs.readdir(tempDir))
      .filter((file) => /^chunk-\d+\.mp3$/.test(file))
      .sort();
    if (files.length === 0) {
      throw new Error("ffmpeg 没有抽取到可转写的音频片段。");
    }

    return Promise.all(
      files.map(async (file, index) => ({
        buffer: await fs.readFile(path.join(tempDir, file)),
        endSeconds: (index + 1) * chunkSeconds,
        format: "mp3" as const,
        startSeconds: index * chunkSeconds,
      })),
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function extractAudioToCachedWav(userId: string, source: RemoteMediaSource): Promise<CachedAudioEntry> {
  const cache = await readUserMediaCache(userId);
  const urls = normalizeRemoteMediaSource(source);
  if (urls.length === 0) {
    throw new Error("媒体资源地址无效。");
  }

  const mediaCacheKey = buildRemoteMediaCacheKey(userId, urls);
  const cached = cache.extractedAudio.get(mediaCacheKey);
  if (cached && (await readFileSize(cached.filePath)) > 0) {
    cached.lastAccessedAt = Date.now();
    return cached;
  }
  cache.extractedAudio.delete(mediaCacheKey);

  const inflight = cache.extractedAudioTasks.get(mediaCacheKey);
  if (inflight) {
    return inflight;
  }

  const task = cacheExtractedAudioFile(userId, mediaCacheKey, urls, cache, cache.generation).finally(() => {
    cache.extractedAudioTasks.delete(mediaCacheKey);
  });
  cache.extractedAudioTasks.set(mediaCacheKey, task);
  return task;
}

export async function downloadRemoteMediaToFile(
  source: RemoteMediaSource,
  outputPath: string,
): Promise<string | undefined> {
  let lastError: unknown;
  const urls = normalizeRemoteMediaSource(source);
  if (urls.length === 0) {
    throw new Error("媒体资源地址无效。");
  }

  for (let urlIndex = 0; urlIndex < urls.length; urlIndex += 1) {
    const url = urls[urlIndex];
    if (urlIndex > 0) {
      await fs.rm(outputPath, { force: true });
    }

    for (let attempt = 1; attempt <= MEDIA_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
      const offset = await readFileSize(outputPath);

      try {
        const result = await downloadMediaRange(url, outputPath, offset);
        const downloadedSize = await readFileSize(outputPath);
        if (result.totalSize === null || downloadedSize >= result.totalSize) {
          return result.contentType;
        }

        lastError = new Error(`下载不完整：${downloadedSize}/${result.totalSize}`);
      } catch (error) {
        lastError = error;
      }

      if (attempt < MEDIA_DOWNLOAD_MAX_ATTEMPTS) {
        await delay(500 * attempt);
      }
    }

  }

  throw new Error(`媒体资源下载失败：${lastError instanceof Error ? lastError.message : "未知错误"}`);
}

export async function downloadRemoteMediaToBuffer(
  userId: string,
  source: RemoteMediaSource,
): Promise<DownloadedRemoteMedia> {
  const media = await downloadRemoteMediaToCachedFile(userId, source);
  return {
    buffer: await fs.readFile(media.filePath),
    contentType: media.contentType,
  };
}

export async function downloadRemoteMediaToCachedFile(
  userId: string,
  source: RemoteMediaSource,
): Promise<CachedRemoteMedia> {
  const cache = await readUserMediaCache(userId);
  const urls = normalizeRemoteMediaSource(source);
  if (urls.length === 0) {
    throw new Error("媒体资源地址无效。");
  }

  const cacheKey = buildRemoteMediaCacheKey(userId, urls);
  const cached = cache.remoteMedia.get(cacheKey);
  if (cached && (await readFileSize(cached.filePath)) > 0) {
    cached.lastAccessedAt = Date.now();
    return cached;
  }
  cache.remoteMedia.delete(cacheKey);

  const inflight = cache.remoteMediaTasks.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const generation = cache.generation;
  const task = cacheRemoteMediaFile(cacheKey, urls, cache, generation).finally(() => {
    cache.remoteMediaTasks.delete(cacheKey);
  });
  cache.remoteMediaTasks.set(cacheKey, task);
  return task;
}

async function downloadMediaRange(
  url: string,
  outputPath: string,
  offset: number,
): Promise<{ contentType?: string; totalSize: number | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "video/mp4,audio/*,*/*;q=0.8",
        referer: DOUYIN_REFERER,
        "user-agent": DOUYIN_USER_AGENT,
        ...(offset > 0 ? { range: `bytes=${offset}-` } : {}),
      },
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (offset > 0 && response.status !== 206) {
      await fs.rm(outputPath, { force: true });
      throw new Error("服务器不支持断点续传。");
    }

    await pipeline(
      Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(outputPath, { flags: offset > 0 ? "a" : "w" }),
    );

    return {
      contentType: response.headers.get("content-type") ?? undefined,
      totalSize: readTotalSize(response, offset),
    };
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  generation: number,
): Promise<CachedRemoteMediaEntry> {
  const cacheDir = path.join(os.tmpdir(), "echolens-media-cache");
  const filePath = path.join(cacheDir, `${cacheKey}.media`);
  const partialPath = path.join(cacheDir, `${cacheKey}.part`);
  await fs.mkdir(cacheDir, { recursive: true });

  const contentType = await downloadRemoteMediaToFile(urls, partialPath);
  await fs.rm(filePath, { force: true });
  await fs.rename(partialPath, filePath);
  if (generation !== cache.generation) {
    await fs.rm(filePath, { force: true });
    throw new Error("作品已切换，请重新发起处理。");
  }

  const entry = {
    contentType,
    filePath,
    lastAccessedAt: Date.now(),
  };
  cache.remoteMedia.set(cacheKey, entry);
  return entry;
}

async function cacheExtractedAudioFile(
  userId: string,
  cacheKey: string,
  urls: string[],
  cache: UserMediaCache,
  generation: number,
): Promise<CachedAudioEntry> {
  const media = await downloadRemoteMediaToCachedFile(userId, urls);
  const cacheDir = path.join(os.tmpdir(), "echolens-audio-cache");
  const filePath = path.join(cacheDir, `${cacheKey}.wav`);
  const partialPath = path.join(cacheDir, `${cacheKey}.wav.part`);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.rm(partialPath, { force: true });

  await runFfmpeg(resolveFfmpegPath(), [
    "-y",
    "-i",
    media.filePath,
    "-vn",
    "-acodec",
    "pcm_s16le",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "wav",
    partialPath,
  ]);
  await fs.rm(filePath, { force: true });
  await fs.rename(partialPath, filePath);
  if (generation !== cache.generation) {
    await fs.rm(filePath, { force: true });
    throw new Error("作品已切换，请重新发起处理。");
  }

  const entry = {
    filePath,
    lastAccessedAt: Date.now(),
  };
  cache.extractedAudio.set(cacheKey, entry);
  return entry;
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
    activeWorkKey: null,
    extractedAudio: new Map(),
    extractedAudioTasks: new Map(),
    generation: 0,
    lastAccessedAt: Date.now(),
    remoteMedia: new Map(),
    remoteMediaTasks: new Map(),
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
  cache.generation += 1;
  cache.remoteMediaTasks.clear();
  cache.extractedAudioTasks.clear();
  await Promise.all([
    clearCachedFiles(cache.remoteMedia),
    clearCachedFiles(cache.extractedAudio),
  ]);
  userMediaCaches.delete(userId);
}

function buildRemoteMediaCacheKey(userId: string, urls: string[]): string {
  return createHash("sha256").update(JSON.stringify([userId, urls])).digest("hex");
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  const stderr: string[] = [];

  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg 抽取音频失败：${stderr.join("").slice(-600)}`));
    });
  });
}

export function resolveFfmpegPath(): string {
  const configuredPath = process.env.FFMPEG_PATH?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  return resolveBundledFfmpegPath();
}
