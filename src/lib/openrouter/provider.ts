import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MediaResources } from "@/lib/douyin/media";

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };
type AudioContentPart = Extract<ChatContentPart, { type: "input_audio" }>;

export type ProviderResult =
  | { ok: true; content: string }
  | { ok: false; code: "not_configured" | "unavailable" | "error"; detail: string };

type OpenRouterError = {
  code?: number;
  message?: string;
  metadata?: Record<string, unknown>;
};

export async function identifyImageContent(imageUrls: string[]): Promise<ProviderResult> {
  if (imageUrls.length === 0) {
    return { ok: false, code: "unavailable", detail: "没有采集到可识别的图片资源。" };
  }

  return callOpenRouter([
    {
      type: "text",
      text:
        [
          "只识别下面按顺序给出的图文笔记图片。",
          "必须按固定格式输出：第1张图片、空行、该图片文字；第2张图片、空行、该图片文字。",
          "每张图片都要单独成段，即使没有可见文字也输出“未识别到文字”。",
          "不要识别或补充未提供的图片，不要编造看不清的内容。",
        ].join("\n"),
    },
    ...imageUrls.flatMap(
      (url, index): ChatContentPart[] => [
        {
          type: "text",
          text: `第${index + 1}张图片`,
        },
        {
          type: "image_url",
          image_url: { url },
        },
      ],
    ),
  ]);

}

export async function transcribeMedia(media: MediaResources): Promise<ProviderResult> {
  const audioUrl = media.audioUrls[0];
  if (!audioUrl) {
    return { ok: false, code: "unavailable", detail: "没有采集到当前作品对应的主音频资源。" };
  }

  try {
    const audioInput = await fetchAudioAsModelInput(audioUrl);
    return transcribeWithOpenRouter(audioInput.input_audio);
  } catch (error) {
    return {
      ok: false,
      code: "error",
      detail: error instanceof Error ? error.message : "读取作品音频失败。",
    };
  }
}

async function transcribeWithOpenRouter(inputAudio: { data: string; format: string }): Promise<ProviderResult> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, code: "not_configured", detail: "OPENROUTER_API_KEY 未配置。" };
  }

  const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = process.env.OPENROUTER_ASR_MODEL || "qwen/qwen3-asr-flash-2026-02-10";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    readPositiveNumber(process.env.EXTRACTION_TIMEOUT_MS, 60_000),
  );

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "http-referer": "https://echolens.local",
      "x-title": "EchoLens",
    },
    body: JSON.stringify({
      model,
      input_audio: inputAudio,
      language: "zh",
    }),
  })
    .catch((error: unknown) => {
      throw new Error(error instanceof Error ? error.message : "OpenRouter 请求失败。");
    })
    .finally(() => clearTimeout(timeout));

  const text = await response.text();
  const payload = parseJson(text) as
    | {
        text?: unknown;
        error?: OpenRouterError;
      }
    | null;

  if (payload?.error) {
    return {
      ok: false,
      code: response.status === 401 || response.status === 403 ? "not_configured" : "error",
      detail: formatOpenRouterError(response.status, payload.error),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: response.status === 401 || response.status === 403 ? "not_configured" : "error",
      detail: formatOpenRouterError(response.status, { message: text || response.statusText }),
    };
  }

  if (typeof payload?.text !== "string" || !payload.text.trim()) {
    return { ok: false, code: "unavailable", detail: "模型没有返回可用转录文本。" };
  }

  return { ok: true, content: payload.text.trim() };
}

async function callOpenRouter(content: ChatContentPart[]): Promise<ProviderResult> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, code: "not_configured", detail: "OPENROUTER_API_KEY 未配置。" };
  }

  const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = process.env.OPENROUTER_MODEL || "xiaomi/mimo-v2.5";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    readPositiveNumber(process.env.EXTRACTION_TIMEOUT_MS, 60_000),
  );
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "http-referer": "https://echolens.local",
      "x-title": "EchoLens",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content,
        },
      ],
    }),
  })
    .catch((error: unknown) => {
      throw new Error(error instanceof Error ? error.message : "OpenRouter 请求失败。");
    })
    .finally(() => clearTimeout(timeout));

  const payload = (await response.json().catch(() => null)) as
    | {
        choices?: Array<{ message?: { content?: unknown } }>;
        error?: OpenRouterError;
      }
    | null;

  if (payload?.error) {
    return {
      ok: false,
      code: response.status === 401 || response.status === 403 ? "not_configured" : "error",
      detail: formatOpenRouterError(response.status, payload.error),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: response.status === 401 || response.status === 403 ? "not_configured" : "error",
      detail: formatOpenRouterError(response.status, undefined),
    };
  }

  const contentText = payload?.choices?.[0]?.message?.content;
  if (typeof contentText !== "string" || !contentText.trim()) {
    return { ok: false, code: "unavailable", detail: "模型没有返回可用文本。" };
  }

  return { ok: true, content: contentText.trim() };
}

async function fetchAudioAsModelInput(audioUrl: string): Promise<AudioContentPart> {
  const buffer = audioUrl.startsWith("data:")
    ? parseDataUrl(audioUrl)
    : await downloadAudio(audioUrl);

  const output = await extractMp3Audio(buffer);
  const maxAudioBytes = readPositiveNumber(process.env.OPENROUTER_MAX_AUDIO_BYTES, 8 * 1024 * 1024);
  if (output.byteLength > maxAudioBytes) {
    throw new Error(`抽取后的音频过大：${formatBytes(output.byteLength)}，当前上限 ${formatBytes(maxAudioBytes)}。`);
  }

  return {
    type: "input_audio",
    input_audio: {
      data: output.toString("base64"),
      format: "mp3",
    },
  };
}

async function downloadAudio(audioUrl: string): Promise<Buffer> {
  const response = await fetch(audioUrl, {
    headers: {
      accept: "audio/*,video/mp4,*/*;q=0.8",
      referer: "https://www.douyin.com/",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`音频资源下载失败：HTTP ${response.status}。抖音临时音频地址可能已过期。`);
  }

  const maxBytes = readPositiveNumber(process.env.OPENROUTER_MAX_SOURCE_AUDIO_BYTES, 10 * 1024 * 1024);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    throw new Error(`音频资源过大：${formatBytes(contentLength)}，当前上限 ${formatBytes(maxBytes)}。`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`音频资源过大：${formatBytes(buffer.byteLength)}，当前上限 ${formatBytes(maxBytes)}。`);
  }
  if (!isValidMp4(buffer)) {
    throw new Error("音频资源不是有效的 MP4/M4A 文件。");
  }

  return buffer;
}

function parseDataUrl(value: string): Buffer {
  const match = value.match(/^data:([^;,]+)?;base64,([\s\S]+)$/);
  if (!match) {
    throw new Error("媒体 data URL 格式无效。");
  }

  return Buffer.from(match[2], "base64");
}

function isValidMp4(buffer: Buffer): boolean {
  return buffer.byteLength >= 12 && buffer.subarray(4, 12).toString("ascii").startsWith("ftyp");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function extractMp3Audio(audioBuffer: Buffer): Promise<Buffer> {
  const ffmpegPath = await resolveFfmpegPath();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-"));
  const inputPath = path.join(tempDir, "input-audio.m4a");
  const outputPath = path.join(tempDir, "audio.mp3");

  try {
    await fs.writeFile(inputPath, audioBuffer);
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "32k",
      outputPath,
    ]);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  const stderr: string[] = [];

  await new Promise<void>((resolve, reject) => {
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

async function resolveFfmpegPath(): Promise<string> {
  const configured = process.env.ECHOLENS_FFMPEG_PATH?.trim();
  if (configured) {
    return configured;
  }

  return path.join(
    process.cwd(),
    "node_modules",
    "@ffmpeg-installer",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatOpenRouterError(
  httpStatus: number,
  error: OpenRouterError | undefined,
): string {
  const status = error?.code ?? httpStatus;
  const message = error?.message;
  const metadata = error?.metadata ? ` metadata=${JSON.stringify(error.metadata)}` : "";

  if (status === 401) {
    return "OpenRouter 认证失败：API Key 无效、已删除，或不属于有效用户。请在 .env 中更换 OPENROUTER_API_KEY 后重启 dev server。";
  }

  if (status === 403) {
    return "OpenRouter 拒绝访问：当前 API Key 没有权限或账户不可用。请检查 OpenRouter 账户、余额和模型权限。";
  }

  if (status === 402) {
    return "OpenRouter 账户或 API Key 余额不足，请充值后重试。";
  }

  if (status === 502 && message === "Provider returned error") {
    return `OpenRouter 上游模型处理失败：provider returned error。请检查 ASR 模型是否支持当前音频格式和大小。${metadata}`;
  }

  return `${message ?? "OpenRouter 返回错误。"}${metadata}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
