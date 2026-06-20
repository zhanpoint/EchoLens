import { spawn } from "node:child_process";
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

export type AudioChunk = {
  buffer: Buffer;
  endSeconds: number;
  format: "mp3";
  startSeconds: number;
};

export function resolveBundledFfmpegPath(): string {
  return path.join(
    process.cwd(),
    "node_modules",
    "@ffmpeg-installer",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
}

export async function normalizeAudioToWav(source: Buffer | string): Promise<Buffer> {
  const ffmpegPath = resolveFfmpegPath();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-"));
  const inputPath = path.join(tempDir, "source-audio");
  const outputPath = path.join(tempDir, "audio.wav");

  try {
    await writeSourceToFile(source, inputPath);

    await runFfmpeg(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      "16000",
      outputPath,
    ]);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function transcodeAudioToMp3Chunks(
  source: Buffer | string,
  chunkSeconds = DEFAULT_MP3_CHUNK_SECONDS,
): Promise<AudioChunk[]> {
  const ffmpegPath = resolveFfmpegPath();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-"));
  const inputPath = path.join(tempDir, "source-audio");
  const outputPattern = path.join(tempDir, "chunk-%03d.mp3");

  try {
    await writeSourceToFile(source, inputPath);

    await runFfmpeg(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-vn",
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

async function writeSourceToFile(source: Buffer | string, outputPath: string): Promise<void> {
  if (Buffer.isBuffer(source)) {
    await fs.writeFile(outputPath, source);
    return;
  }

  await downloadRemoteMediaToFile(source, outputPath);
}

export async function downloadRemoteMediaToFile(url: string, outputPath: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MEDIA_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
    const offset = await readFileSize(outputPath);

    try {
      const totalSize = await downloadMediaRange(url, outputPath, offset);
      const downloadedSize = await readFileSize(outputPath);
      if (totalSize === null || downloadedSize >= totalSize) {
        return;
      }

      lastError = new Error(`下载不完整：${downloadedSize}/${totalSize}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < MEDIA_DOWNLOAD_MAX_ATTEMPTS) {
      await delay(500 * attempt);
    }
  }

  throw new Error(`媒体资源下载失败：${lastError instanceof Error ? lastError.message : "未知错误"}`);
}

async function downloadMediaRange(url: string, outputPath: string, offset: number): Promise<number | null> {
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

    return readTotalSize(response, offset);
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
