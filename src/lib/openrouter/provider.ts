import { createHash } from "node:crypto";
import { transcodeAudioToMp3Chunks } from "@/lib/media/audio";
import type { TranscriptSegment } from "@/types/douyin";

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };
type AudioContentPart = Extract<ChatContentPart, { type: "input_audio" }>;
type AudioInputSegment = AudioContentPart & {
  endSeconds: number;
  startSeconds: number;
};

export type ProviderResult =
  | { ok: true; content: string; transcriptSegments?: TranscriptSegment[] }
  | { ok: false; code: "not_configured" | "unavailable" | "error"; detail: string };

type OpenRouterError = {
  code?: number;
  message?: string;
  metadata?: Record<string, unknown>;
};

const TRANSCRIPT_CACHE_TTL_MS = 10 * 60_000;
const TRANSCRIPT_CACHE_MAX_ENTRIES = 64;
const MAX_USER_TRANSCRIPT_CACHES = 256;
const OPENROUTER_MAX_RETRIES = 2;
const OPENROUTER_RETRYABLE_STATUSES = new Set([429, 503]);
const OPENROUTER_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_ASR_CHUNK_SECONDS = 300;
const DEFAULT_SUMMARY_MODEL = "deepseek/deepseek-v4-flash";

type CachedTranscript = {
  expiresAt: number;
  result: Extract<ProviderResult, { ok: true }>;
};
type UserTranscriptCache = {
  activeWorkKey: string | null;
  entries: Map<string, CachedTranscript>;
  inflight: Map<string, Promise<ProviderResult>>;
  lastAccessedAt: number;
};

const userTranscriptCaches = new Map<string, UserTranscriptCache>();

export async function summarizeTranscript(
  transcript: string,
  prompt: string,
): Promise<ProviderResult> {
  const text = transcript.trim();
  const instruction = prompt.trim();
  if (!text) {
    return { ok: false, code: "unavailable", detail: "没有可总结的转写文本。" };
  }
  if (!instruction) {
    return { ok: false, code: "unavailable", detail: "请选择或填写总结提示词。" };
  }

  return callOpenRouter(
    [
      {
        type: "text",
        text: [
          instruction,
          "",
          "只基于下面的转写文本总结，不要补充文本中没有的信息。",
          "输出中文，结构清晰，保留关键实体、数字、结论和行动建议。",
          "",
          "转写文本：",
          text,
        ].join("\n"),
      },
    ],
    {
      model: process.env.OPENROUTER_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL,
    },
  );
}

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

export async function transcribeMediaSource(
  userId: string,
  workKey: string,
  sourceUrl: string | readonly string[] | undefined,
  missingDetail = "没有采集到当前作品对应的音频资源。",
): Promise<ProviderResult> {
  if (!hasMediaSource(sourceUrl)) {
    return { ok: false, code: "unavailable", detail: missingDetail };
  }

  const cache = prepareTranscriptCacheForWork(userId, workKey);
  const cacheKey = buildTranscriptCacheKey(cache.activeWorkKey, sourceUrl);
  const cached = getCachedTranscript(cache, cacheKey);
  if (cached) {
    return cached;
  }

  const inflight = cache.inflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const task = (async (): Promise<ProviderResult> => {
    try {
      const audioInputs = await fetchAudioAsModelInputs(userId, sourceUrl);
      const result = await transcribeAudioChunksWithOpenRouter(audioInputs);
      if (result.ok && cache.activeWorkKey === workKey.trim()) {
        cacheTranscript(cache, cacheKey, result);
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        code: "error",
        detail: error instanceof Error ? error.message : "读取作品音频失败。",
      };
    } finally {
      cache.inflight.delete(cacheKey);
    }
  })();

  cache.inflight.set(cacheKey, task);
  return task;
}

export function prepareTranscriptCacheForWork(userId: string, workKey: string): UserTranscriptCache {
  const cache = readUserTranscriptCache(userId);
  const nextWorkKey = workKey.trim();
  if (!nextWorkKey || cache.activeWorkKey === nextWorkKey) {
    return cache;
  }

  cache.activeWorkKey = nextWorkKey;
  cache.entries.clear();
  cache.inflight.clear();
  return cache;
}

async function transcribeAudioChunksWithOpenRouter(
  inputAudios: AudioInputSegment[],
): Promise<ProviderResult> {
  const transcriptSegments: TranscriptSegment[] = [];

  for (let index = 0; index < inputAudios.length; index += 1) {
    const input = inputAudios[index];
    const result = await transcribeWithOpenRouter(input.input_audio);
    if (result.ok) {
      transcriptSegments.push({
        endSeconds: input.endSeconds,
        startSeconds: input.startSeconds,
        text: result.content,
      });
      continue;
    }
    if (result.code === "unavailable") {
      continue;
    }

    return inputAudios.length > 1
      ? { ...result, detail: `第${index + 1}段音频转写失败：${result.detail}` }
      : result;
  }

  const content = joinTranscriptChunks(transcriptSegments.map((segment) => segment.text));
  return content
    ? { ok: true, content, transcriptSegments }
    : { ok: false, code: "unavailable", detail: "模型没有识别到可用转录文本。" };
}

function joinTranscriptChunks(chunks: string[]): string {
  return chunks
    .map((chunk) => chunk.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .reduce((content, chunk) => {
      if (!content) {
        return chunk;
      }
      return `${content}${needsWordBoundary(content, chunk) ? " " : ""}${chunk}`;
    }, "");
}

function needsWordBoundary(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
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

async function callOpenRouter(
  content: ChatContentPart[],
  options?: { model?: string },
): Promise<ProviderResult> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, code: "not_configured", detail: "OPENROUTER_API_KEY 未配置。" };
  }

  const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = options?.model || process.env.OPENROUTER_MODEL || "xiaomi/mimo-v2.5";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OPENROUTER_REQUEST_TIMEOUT_MS,
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

async function fetchAudioAsModelInputs(userId: string, sourceUrl: string | readonly string[]): Promise<AudioInputSegment[]> {
  const chunks = await transcodeAudioToMp3Chunks(
    userId,
    sourceUrl,
    readPositiveNumber(process.env.OPENROUTER_ASR_CHUNK_SECONDS, DEFAULT_ASR_CHUNK_SECONDS),
  );

  return chunks.map((chunk) => ({
    endSeconds: chunk.endSeconds,
    startSeconds: chunk.startSeconds,
    type: "input_audio",
    input_audio: {
      data: chunk.buffer.toString("base64"),
      format: chunk.format,
    },
  }));
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
    OPENROUTER_REQUEST_TIMEOUT_MS,
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

function buildTranscriptCacheKey(workKey: string | null, sourceUrl: string | readonly string[]): string {
  return `${getAsrModel()}:${createHash("sha256").update(JSON.stringify([workKey, sourceUrl])).digest("hex")}`;
}

function hasMediaSource(sourceUrl: string | readonly string[] | undefined): sourceUrl is string | readonly string[] {
  return typeof sourceUrl === "string" ? Boolean(sourceUrl.trim()) : Boolean(sourceUrl?.length);
}

function getCachedTranscript(
  cache: UserTranscriptCache,
  key: string,
): Extract<ProviderResult, { ok: true }> | null {
  const cached = cache.entries.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    cache.entries.delete(key);
    return null;
  }
  return cached.result;
}

function cacheTranscript(
  cache: UserTranscriptCache,
  key: string,
  result: Extract<ProviderResult, { ok: true }>,
): void {
  pruneTranscriptCache(cache);
  cache.entries.set(key, {
    result,
    expiresAt: Date.now() + TRANSCRIPT_CACHE_TTL_MS,
  });

  while (cache.entries.size > TRANSCRIPT_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.entries.keys().next().value;
    if (!oldestKey) {
      break;
    }
    cache.entries.delete(oldestKey);
  }
}

function pruneTranscriptCache(cache: UserTranscriptCache, now = Date.now()): void {
  for (const [key, cached] of cache.entries) {
    if (cached.expiresAt <= now) {
      cache.entries.delete(key);
    }
  }
}

function readUserTranscriptCache(userId: string): UserTranscriptCache {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("用户身份无效。");
  }

  const existing = userTranscriptCaches.get(normalizedUserId);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    return existing;
  }

  const cache: UserTranscriptCache = {
    activeWorkKey: null,
    entries: new Map(),
    inflight: new Map(),
    lastAccessedAt: Date.now(),
  };
  userTranscriptCaches.set(normalizedUserId, cache);
  trimUserTranscriptCaches(normalizedUserId);
  return cache;
}

function trimUserTranscriptCaches(activeUserId: string): void {
  if (userTranscriptCaches.size <= MAX_USER_TRANSCRIPT_CACHES) {
    return;
  }

  const overflow = userTranscriptCaches.size - MAX_USER_TRANSCRIPT_CACHES;
  const staleUsers = [...userTranscriptCaches.entries()]
    .filter(([userId]) => userId !== activeUserId)
    .sort(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt)
    .slice(0, overflow)
    .map(([userId]) => userId);

  for (const userId of staleUsers) {
    userTranscriptCaches.delete(userId);
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
