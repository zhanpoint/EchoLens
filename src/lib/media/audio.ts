import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const DOUYIN_REFERER = "https://www.douyin.com/";
const DOUYIN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FFMPEG_RW_TIMEOUT_US = "30000000";
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
    const inputArgs = Buffer.isBuffer(source)
      ? ["-i", inputPath]
      : buildRemoteInputArgs(source);

    if (Buffer.isBuffer(source)) {
      await fs.writeFile(inputPath, source);
    }

    await runFfmpeg(ffmpegPath, [
      "-y",
      ...inputArgs,
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
    const inputArgs = Buffer.isBuffer(source)
      ? ["-i", inputPath]
      : buildRemoteInputArgs(source);

    if (Buffer.isBuffer(source)) {
      await fs.writeFile(inputPath, source);
    }

    await runFfmpeg(ffmpegPath, [
      "-y",
      ...inputArgs,
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

function buildRemoteInputArgs(url: string): string[] {
  return [
    "-rw_timeout",
    FFMPEG_RW_TIMEOUT_US,
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "2",
    "-user_agent",
    DOUYIN_USER_AGENT,
    "-referer",
    DOUYIN_REFERER,
    "-i",
    url,
  ];
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

function resolveFfmpegPath(): string {
  return resolveBundledFfmpegPath();
}
