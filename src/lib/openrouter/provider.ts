import { createHash } from "node:crypto";
import { normalizeAudioToWav } from "@/lib/media/audio";

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

const TRANSCRIPT_CACHE_TTL_MS = 10 * 60_000;
const TRANSCRIPT_CACHE_MAX_ENTRIES = 64;
const OPENROUTER_MAX_RETRIES = 2;
const OPENROUTER_RETRYABLE_STATUSES = new Set([429, 503]);

const transcriptCache = new Map<string, { expiresAt: number; result: Extract<ProviderResult, { ok: true }> }>();
const transcriptInflight = new Map<string, Promise<ProviderResult>>();

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

export async function transcribeMediaSource(sourceUrl: string | undefined): Promise<ProviderResult> {
  if (!sourceUrl) {
    return { ok: false, code: "unavailable", detail: "没有采集到当前作品对应的主音频资源。" };
  }

  const cacheKey = buildTranscriptCacheKey(sourceUrl);
  const cached = getCachedTranscript(cacheKey);
  if (cached) {
    return cached;
  }

  const inflight = transcriptInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const task = (async (): Promise<ProviderResult> => {
    try {
      const audioInput = await fetchAudioAsModelInput(sourceUrl);
      const result = await transcribeWithOpenRouter(audioInput.input_audio);
      if (result.ok) {
        cacheTranscript(cacheKey, result);
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        code: "error",
        detail: error instanceof Error ? error.message : "读取作品音频失败。",
      };
    } finally {
      transcriptInflight.delete(cacheKey);
    }
  })();

  transcriptInflight.set(cacheKey, task);
  return task;
}

async function transcribeWithOpenRouter(inputAudio: { data: string; format: string }): Promise<ProviderResult> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, code: "not_configured", detail: "OPENROUTER_API_KEY 未配置。" };
  }

  const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = getAsrModel();

  for (let attempt = 0; attempt <= OPENROUTER_MAX_RETRIES; attempt += 1) {
    const response = await postOpenRouterAudioTranscription(baseUrl, apiKey, model, inputAudio);
    const text = await response.text();
    const payload = parseJson(text) as
      | {
          text?: unknown;
          error?: OpenRouterError;
        }
      | null;

    if (shouldRetryOpenRouter(response.status, attempt)) {
      await delay(getRetryDelayMs(response.headers.get("retry-after"), attempt));
      continue;
    }

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
      return { ok: false, code: "unavailable", detail: "模型没有识别到可用转录文本。" };
    }

    return { ok: true, content: payload.text.trim() };
  }

  return {
    ok: false,
    code: "error",
    detail: "OpenRouter ASR 请求在多次限流重试后仍未成功，请稍后重试。",
  };
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

async function fetchAudioAsModelInput(sourceUrl: string): Promise<AudioContentPart> {
  const output = sourceUrl.startsWith("data:")
    ? await normalizeAudioToWav(parseDataUrl(sourceUrl))
    : await normalizeAudioToWav(sourceUrl);
  const maxAudioBytes = readPositiveNumber(process.env.OPENROUTER_MAX_AUDIO_BYTES, 8 * 1024 * 1024);
  if (output.byteLength > maxAudioBytes) {
    throw new Error(`抽取后的音频过大：${formatBytes(output.byteLength)}，当前上限 ${formatBytes(maxAudioBytes)}。`);
  }

  return {
    type: "input_audio",
    input_audio: {
      data: output.toString("base64"),
      format: "wav",
    },
  };
}

async function postOpenRouterAudioTranscription(
  baseUrl: string,
  apiKey: string,
  model: string,
  inputAudio: { data: string; format: string },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    readPositiveNumber(process.env.EXTRACTION_TIMEOUT_MS, 60_000),
  );

  return fetch(`${baseUrl}/audio/transcriptions`, {
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
}

function parseDataUrl(value: string): Buffer {
  const match = value.match(/^data:([^;,]+)?;base64,([\s\S]+)$/);
  if (!match) {
    throw new Error("媒体 data URL 格式无效。");
  }

  return Buffer.from(match[2], "base64");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getAsrModel(): string {
  return process.env.OPENROUTER_ASR_MODEL || "qwen/qwen3-asr-flash-2026-02-10";
}

function buildTranscriptCacheKey(sourceUrl: string): string {
  return `${getAsrModel()}:${createHash("sha256").update(sourceUrl).digest("hex")}`;
}

function getCachedTranscript(key: string): Extract<ProviderResult, { ok: true }> | null {
  const cached = transcriptCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    transcriptCache.delete(key);
    return null;
  }
  return cached.result;
}

function cacheTranscript(key: string, result: Extract<ProviderResult, { ok: true }>): void {
  pruneTranscriptCache();
  transcriptCache.set(key, {
    result,
    expiresAt: Date.now() + TRANSCRIPT_CACHE_TTL_MS,
  });

  while (transcriptCache.size > TRANSCRIPT_CACHE_MAX_ENTRIES) {
    const oldestKey = transcriptCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    transcriptCache.delete(oldestKey);
  }
}

function pruneTranscriptCache(now = Date.now()): void {
  for (const [key, cached] of transcriptCache) {
    if (cached.expiresAt <= now) {
      transcriptCache.delete(key);
    }
  }
}

function shouldRetryOpenRouter(status: number, attempt: number): boolean {
  return OPENROUTER_RETRYABLE_STATUSES.has(status) && attempt < OPENROUTER_MAX_RETRIES;
}

function getRetryDelayMs(retryAfter: string | null, attempt: number): number {
  const retryAfterDelay = parseRetryAfterMs(retryAfter);
  if (retryAfterDelay !== null) {
    return retryAfterDelay;
  }
  return Math.min(1_000 * 2 ** attempt, 8_000);
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(timestamp - Date.now(), 0);
  }
  return null;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

  if (status === 429) {
    return `OpenRouter 或上游 ASR 提供方触发限流，系统已按 Retry-After 自动退避重试。当前仍被限流，请稍后重试或减少重复提取。${metadata}`;
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
