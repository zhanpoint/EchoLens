import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const DOUYIN_REFERER = "https://www.douyin.com/";
const DOUYIN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

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
    await fs.writeFile(inputPath, Buffer.isBuffer(source) ? source : await downloadMedia(source));

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

async function downloadMedia(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      accept: "audio/*,video/*,*/*;q=0.8",
      referer: DOUYIN_REFERER,
      "user-agent": DOUYIN_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`媒体资源下载失败：HTTP ${response.status}。抖音临时地址可能已过期。`);
  }

  const maxBytes = readPositiveNumber(process.env.ECHOLENS_MAX_SOURCE_MEDIA_BYTES, 50 * 1024 * 1024);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    throw new Error(`媒体资源过大：${formatBytes(contentLength)}，当前上限 ${formatBytes(maxBytes)}。`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`媒体资源过大：${formatBytes(buffer.byteLength)}，当前上限 ${formatBytes(maxBytes)}。`);
  }

  return buffer;
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

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
