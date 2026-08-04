import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bilibiliMediaHeaders,
  getBilibiliDashSelection,
  type BilibiliWorkMetadata,
} from "@/lib/bilibili/client";
import { downloadBilibiliStream } from "@/lib/bilibili/range-downloader";
import type {
  BilibiliAudioQuality,
  BilibiliStreamFormat,
  BilibiliVideoCodec,
  BilibiliVideoQuality,
} from "@/lib/download-settings";
import { resolveFfmpegPath } from "@/lib/media/audio";

export const BILIBILI_VIDEO_CACHE_TTL_MS = 2 * 60 * 60 * 1_000;

const CACHE_DIRECTORY = join(tmpdir(), "echolens-bilibili-video-cache");
const tasks = new Map<string, Promise<BilibiliCachedVideo>>();
const deletionTimers = new Map<string, NodeJS.Timeout>();

type BilibiliVideoOptions = {
  audioQuality: BilibiliAudioQuality;
  streamFormat: BilibiliStreamFormat;
  videoCodec: BilibiliVideoCodec;
  videoQuality: BilibiliVideoQuality;
};

export type BilibiliCachedVideo = {
  cacheKey: string;
  contentType: "video/mp4";
  expiresAt: number;
  filePath: string;
  sizeBytes: number;
};

export function buildBilibiliVideoCacheKey(input: {
  options: BilibiliVideoOptions;
  userId: string;
  workId: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([input.userId, input.workId, input.options]))
    .digest("hex");
}

export async function ensureBilibiliVideoCached(input: {
  cacheKey: string;
  cookie?: string;
  metadata: BilibiliWorkMetadata;
  options: BilibiliVideoOptions;
}): Promise<BilibiliCachedVideo> {
  const cached = await readBilibiliVideoCache(input.cacheKey);
  if (cached) return cached;

  const existing = tasks.get(input.cacheKey);
  if (existing) return existing;
  const task = downloadAndMergeVideo(input).finally(() => {
    if (tasks.get(input.cacheKey) === task) tasks.delete(input.cacheKey);
  });
  tasks.set(input.cacheKey, task);
  return task;
}

export async function readBilibiliVideoCache(cacheKey: string): Promise<BilibiliCachedVideo | null> {
  await cleanupBilibiliVideoCache();
  if (!/^[a-f0-9]{64}$/u.test(cacheKey)) return null;
  const filePath = cachePath(cacheKey);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile() || !info.size) {
    await rm(filePath, { force: true });
    return null;
  }

  const expiresAt = info.mtimeMs + BILIBILI_VIDEO_CACHE_TTL_MS;
  if (expiresAt <= Date.now()) {
    await deleteCachedVideo(cacheKey);
    return null;
  }
  scheduleDeletion(cacheKey, expiresAt);
  return { cacheKey, contentType: "video/mp4", expiresAt, filePath, sizeBytes: info.size };
}

async function downloadAndMergeVideo(input: {
  cacheKey: string;
  cookie?: string;
  metadata: BilibiliWorkMetadata;
  options: BilibiliVideoOptions;
}): Promise<BilibiliCachedVideo> {
  await mkdir(CACHE_DIRECTORY, { recursive: true });
  await cleanupBilibiliVideoCache();

  const selection = await getBilibiliDashSelection({
    audioQuality: input.options.audioQuality,
    bvid: input.metadata.bvid,
    cid: input.metadata.cid,
    codec: input.options.videoCodec,
    cookie: input.cookie,
    streamFormat: input.options.streamFormat,
    videoQuality: input.options.videoQuality,
  });
  const headers = bilibiliMediaHeaders(input.cookie);
  const [video, audio] = await Promise.all([
    downloadBilibiliStream({ headers, name: "video.m4s", urls: selection.video.urls }),
    downloadBilibiliStream({ headers, name: "audio.m4s", urls: selection.audio.urls }),
  ]);
  const finalPath = cachePath(input.cacheKey);
  const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mergeDashStreams(video.filePath, audio.filePath, temporaryPath);
    await rename(temporaryPath, finalPath);
    const info = await stat(finalPath);
    const expiresAt = info.mtimeMs + BILIBILI_VIDEO_CACHE_TTL_MS;
    scheduleDeletion(input.cacheKey, expiresAt);
    return {
      cacheKey: input.cacheKey,
      contentType: "video/mp4",
      expiresAt,
      filePath: finalPath,
      sizeBytes: info.size,
    };
  } finally {
    await Promise.all([
      video.cleanup(),
      audio.cleanup(),
      rm(temporaryPath, { force: true }),
    ]);
  }
}

async function mergeDashStreams(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-i", videoPath, "-i", audioPath,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", "-y", outputPath,
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`FFmpeg 封装失败：${stderr}`)));
  });
}

export async function cleanupBilibiliVideoCache(): Promise<void> {
  const entries = await readdir(CACHE_DIRECTORY, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const filePath = join(CACHE_DIRECTORY, entry.name);
    const info = await stat(filePath).catch(() => null);
    if (!info) return;
    const expiredMedia = /^[a-f0-9]{64}\.mp4$/u.test(entry.name) && info.mtimeMs + BILIBILI_VIDEO_CACHE_TTL_MS <= now;
    const staleTemporary = /^[a-f0-9]{64}\.mp4\.\d+\.\d+\.tmp$/u.test(entry.name) && info.mtimeMs + BILIBILI_VIDEO_CACHE_TTL_MS <= now;
    if (expiredMedia || staleTemporary || info.size === 0) {
      await rm(filePath, { force: true });
    }
  }));
}

function scheduleDeletion(cacheKey: string, expiresAt: number): void {
  const current = deletionTimers.get(cacheKey);
  if (current) clearTimeout(current);
  const timer = setTimeout(() => {
    deletionTimers.delete(cacheKey);
    void deleteCachedVideo(cacheKey);
  }, Math.max(0, expiresAt - Date.now()));
  timer.unref();
  deletionTimers.set(cacheKey, timer);
}

async function deleteCachedVideo(cacheKey: string): Promise<void> {
  const timer = deletionTimers.get(cacheKey);
  if (timer) clearTimeout(timer);
  deletionTimers.delete(cacheKey);
  await rm(cachePath(cacheKey), { force: true });
}

function cachePath(cacheKey: string): string {
  return join(CACHE_DIRECTORY, `${cacheKey}.mp4`);
}