import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const BILIBILI_REFERER = "https://www.bilibili.com/";
const DOUYIN_REFERER = "https://www.douyin.com/";
const MEDIA_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MEDIA_DOWNLOAD_TIMEOUT_MS = 600_000;
const FFMPEG_AUDIO_EXTRACT_TIMEOUT_MS = 600_000;
const FFMPEG_AUDIO_PROBE_TIMEOUT_MS = 60_000;
const FFMPEG_STDERR_TAIL_CHARS = 8_192;
const MAX_TRANSCRIBE_AUDIO_DURATION_SECONDS = 12 * 60 * 60;
const MAX_TRANSCRIBE_AUDIO_BYTES = 2 * 1024 * 1024 * 1024;

export type RemoteMediaSource = string | readonly string[];
export type MediaSourcePlatform = "bilibili" | "douyin";
export type AudioTranscriptionLimits = {
  durationLimitMessage?: string;
  maxBytes?: number;
  maxDurationSeconds?: number;
  sizeLimitMessage?: string;
};
export type TranscribableAudioFile = {
  cleanup: () => Promise<void>;
  contentType: "audio/mp4";
  durationSeconds: number;
  filePath: string;
  sizeBytes: number;
};

export class AudioTranscriptionLimitError extends Error {}

export function resolveBundledFfmpegPath(): string {
  return ffmpegInstaller.path;
}

/** Proxies an upstream media response without retaining it on the application server. */
export async function fetchRemoteMedia(
  source: RemoteMediaSource,
  options: {
    mediaSource?: MediaSourcePlatform;
    range?: string | null;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const urls = normalizeRemoteMediaSource(source);
  if (!urls.length) {
    throw new Error("媒体资源地址无效。");
  }

  let lastError: unknown;
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);
    const signal = linkedAbortSignal(controller.signal, options.signal);
    try {
      const response = await fetch(url, {
        headers: { ...mediaDownloadHeaders(options.mediaSource), ...(options.range ? { range: options.range } : {}) },
        signal,
      });
      if (response.ok && response.body) {
        return response;
      }
      await response.body?.cancel();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`媒体资源下载失败：${lastError instanceof Error ? lastError.message : "未知错误"}`);
}

/** Creates a finalized seekable M4A file before any remote upload. */
export async function createTranscribableAudioFileFromNode(
  source: Readable,
  limits: AudioTranscriptionLimits = {},
): Promise<TranscribableAudioFile> {
  const directory = await mkdtemp(join(tmpdir(), "echolens-audio-"));
  const inputPath = join(directory, "source.mp4");
  const filePath = join(directory, "audio.m4a");
  const maxBytes = limits.maxBytes ?? MAX_TRANSCRIBE_AUDIO_BYTES;
  const maxDurationSeconds = limits.maxDurationSeconds ?? MAX_TRANSCRIBE_AUDIO_DURATION_SECONDS;

  try {
    await pipeline(source, createWriteStream(inputPath));
    const durationSeconds = await extractAudioFile(inputPath, filePath);
    const sizeBytes = (await stat(filePath)).size;
    if (!sizeBytes) throw new Error("ffmpeg 抽取的音频为空。");
    if (sizeBytes > maxBytes) {
      throw new AudioTranscriptionLimitError(limits.sizeLimitMessage ?? "转写的音频大小不能超过 2GB，暂不能提取。");
    }
    if (durationSeconds > maxDurationSeconds) {
      throw new AudioTranscriptionLimitError(limits.durationLimitMessage ?? "音频时长不能超过 12 小时，暂不能提取。");
    }
    return {
      cleanup: () => rm(directory, { force: true, recursive: true }),
      contentType: "audio/mp4",
      durationSeconds,
      filePath,
      sizeBytes,
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

async function extractAudioFile(inputPath: string, outputPath: string): Promise<number> {
  const child = spawn(resolveFfmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-i", inputPath,
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k",
    "-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:2", "-nostats", "-y", outputPath,
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let durationSeconds = 0;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = tailText(`${stderr}${chunk}`, FFMPEG_STDERR_TAIL_CHARS);
    durationSeconds = Math.max(durationSeconds, parseFfmpegProgressDurationSeconds(stderr));
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("ffmpeg 抽取音频超时。"));
    }, FFMPEG_AUDIO_EXTRACT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 抽取音频失败：${stderr.slice(-600) || `ffmpeg exited with code ${code}`}`));
    });
  });
  return durationSeconds;
}

export type MuxedVideoFile = {
  cleanup: () => Promise<void>;
  contentType: "video/mp4";
  filePath: string;
  sizeBytes: number;
};

export async function muxVideoAndAudioToFile(
  video: Readable,
  audio: Readable,
  limits: { maxAudioBytes?: number; maxVideoBytes?: number } = {},
): Promise<MuxedVideoFile> {
  const directory = await mkdtemp(join(tmpdir(), "echolens-mux-"));
  const videoPath = join(directory, "video.mp4");
  const audioPath = join(directory, "audio.m4a");
  const outputPath = join(directory, "output.mp4");
  try {
    await Promise.all([
      pipeline(video, byteLimitStream(limits.maxVideoBytes, "DASH 视频"), createWriteStream(videoPath)),
      pipeline(audio, byteLimitStream(limits.maxAudioBytes, "DASH 音频"), createWriteStream(audioPath)),
    ]);
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-i", videoPath, "-i", audioPath,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "copy", "-shortest",
      "-movflags", "+faststart", "-y", outputPath,
    ], "ffmpeg 合流音视频");
    return {
      cleanup: () => rm(directory, { force: true, recursive: true }),
      contentType: "video/mp4",
      filePath: outputPath,
      sizeBytes: (await stat(outputPath)).size,
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

export async function muxVideoAndAudioFromNode(
  video: Readable,
  audio: Readable,
): Promise<Uint8Array> {
  const file = await muxVideoAndAudioToFile(video, audio);
  try {
    return new Uint8Array(await readFile(file.filePath));
  } finally {
    await file.cleanup();
  }
}

function byteLimitStream(maxBytes: number | undefined, label: string): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (maxBytes !== undefined && received > maxBytes) {
        callback(new Error(`${label}超过临时缓存上限。`));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function runFfmpeg(args: string[], operation: string): Promise<void> {
  const child = spawn(resolveFfmpegPath(), args, {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = tailText(`${stderr}${chunk}`, FFMPEG_STDERR_TAIL_CHARS);
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${operation}超时。`));
    }, FFMPEG_AUDIO_EXTRACT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${operation}失败：${stderr.slice(-600) || `ffmpeg exited with code ${code}`}`));
    });
  });
}

export function resolveFfmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || resolveBundledFfmpegPath();
}

/** Confirms that a stored audio object can be opened and its first audio frame decoded. */
export async function probeTranscribableAudioFromUrl(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-i", sourceUrl,
      "-map", "0:a:0", "-frames:a", "1", "-f", "null", "-",
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(abortError());
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("OSS 原声音频探测超时。"));
    }, FFMPEG_AUDIO_PROBE_TIMEOUT_MS);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = tailText(`${stderr}${chunk}`, FFMPEG_STDERR_TAIL_CHARS);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(code === 0
      ? undefined
      : new Error(`OSS 原声音频无法解码：${stderr.slice(-600) || `ffmpeg exited with code ${code}`}`)));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function normalizeRemoteMediaSource(source: RemoteMediaSource): string[] {
  const urls = Array.isArray(source) ? source : [source];
  return Array.from(new Set(urls.map((url) => url.trim()).filter((url) => /^https?:\/\//u.test(url))));
}

function mediaDownloadHeaders(mediaSource: MediaSourcePlatform = "douyin"): Record<string, string> {
  return {
    accept: "video/mp4,audio/*,*/*;q=0.8",
    referer: mediaSource === "bilibili" ? BILIBILI_REFERER : DOUYIN_REFERER,
    "user-agent": MEDIA_USER_AGENT,
  };
}

function parseFfmpegProgressDurationSeconds(chunk: string): number {
  return chunk.split(/\r?\n/u).reduce((max, line) => {
    const value = line.match(/^out_time=(\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)$/u);
    return value ? Math.max(max, Number(value[1]) * 3600 + Number(value[2]) * 60 + Number(value[3])) : max;
  }, 0);
}

function tailText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function linkedAbortSignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals.filter((value): value is AbortSignal => Boolean(value))) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function abortError(): Error {
  const error = new Error("媒体处理已取消。");
  error.name = "AbortError";
  return error;
}
