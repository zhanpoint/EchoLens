import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { runFfmpegProcess } from "./ffmpeg-runner";

const runtimeRequire = process.getBuiltinModule("module").createRequire(/* turbopackIgnore: true */ import.meta.url);

const BILIBILI_REFERER = "https://www.bilibili.com/";
const DOUYIN_REFERER = "https://www.douyin.com/";
const MEDIA_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MEDIA_DOWNLOAD_TIMEOUT_MS = 600_000;
const FFMPEG_AUDIO_EXTRACT_TIMEOUT_MS = 600_000;
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

export class AudioUnavailableError extends Error {}
export class AudioTranscriptionLimitError extends AudioUnavailableError {}

export function resolveBundledFfmpegPath(): string {
  // Native runtime loading avoids tracing the installer's legacy dynamic filesystem search.
  const installer = runtimeRequire("@ffmpeg-installer/ffmpeg") as { path: string };
  return installer.path;
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
    options.signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([deadline, options.signal])
      : deadline;
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
      if (options.signal?.aborted) throw options.signal.reason;
      lastError = error;
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
    const sizeBytes = (await stat(/* turbopackIgnore: true */ filePath)).size;
    if (!sizeBytes) throw new AudioUnavailableError("ffmpeg 抽取的音频为空。");
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
  let progress = "";
  let durationSeconds = 0;
  await runFfmpegProcess({
    binary: resolveFfmpegPath(),
    args: [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-i", inputPath,
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k",
      "-movflags", "+faststart", "-f", "mp4", "-y", outputPath,
    ],
    operation: "ffmpeg 抽取音频",
    timeoutMs: FFMPEG_AUDIO_EXTRACT_TIMEOUT_MS,
    onStderr: (chunk) => {
      progress = `${progress}${chunk}`;
      const lineEnd = progress.lastIndexOf("\n");
      if (lineEnd < 0) {
        progress = progress.slice(-8_192);
        return;
      }
      durationSeconds = Math.max(durationSeconds, parseFfmpegProgressDurationSeconds(progress.slice(0, lineEnd)));
      progress = progress.slice(lineEnd + 1);
    },
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
  video: Readable | string,
  audio: Readable | string,
  limits: { maxAudioBytes?: number; maxVideoBytes?: number } = {},
): Promise<MuxedVideoFile> {
  const directory = await mkdtemp(join(tmpdir(), "echolens-mux-"));
  const outputPath = join(directory, "output.mp4");
  try {
    const inputs = [
      prepareMuxInput(video, join(directory, "video.mp4"), limits.maxVideoBytes, "DASH 视频"),
      prepareMuxInput(audio, join(directory, "audio.m4a"), limits.maxAudioBytes, "DASH 音频"),
    ];
    let videoPath: string;
    let audioPath: string;
    try {
      [videoPath, audioPath] = await Promise.all(inputs);
    } catch (error) {
      if (video instanceof Readable) video.destroy();
      if (audio instanceof Readable) audio.destroy();
      await Promise.allSettled(inputs);
      throw error;
    }
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
      sizeBytes: (await stat(/* turbopackIgnore: true */ outputPath)).size,
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

async function prepareMuxInput(source: Readable | string, destination: string, maxBytes: number | undefined, label: string): Promise<string> {
  if (typeof source === "string") {
    if (maxBytes !== undefined && (await stat(/* turbopackIgnore: true */ source)).size > maxBytes) {
      throw new Error(`${label}超过临时缓存上限。`);
    }
    return source;
  }
  await pipeline(source, byteLimitStream(maxBytes, label), createWriteStream(destination));
  return destination;
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
  await runFfmpegProcess({
    args,
    binary: resolveFfmpegPath(),
    operation,
    timeoutMs: FFMPEG_AUDIO_EXTRACT_TIMEOUT_MS,
  });
}

export function resolveFfmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || resolveBundledFfmpegPath();
}

function normalizeRemoteMediaSource(source: RemoteMediaSource): string[] {
  const urls = Array.isArray(source) ? source : [source];
  return Array.from(new Set(urls.map((url) => url.trim()).filter((url) => /^https?:\/\//u.test(url))));
}

export function mediaDownloadHeaders(mediaSource: MediaSourcePlatform = "douyin"): Record<string, string> {
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
