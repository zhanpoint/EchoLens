import type { ProviderResult } from "@/lib/ai/provider-result";
import {
  buildTranscriptPostprocessPrompt,
  type TimestampedPromptSegment,
} from "@/lib/ai/prompts";
import { fetchWithRetry } from "@/lib/http/retry";
import { readSseJsonStream } from "@/lib/http/sse";
import type { TranscriptSegment } from "@/types/douyin";

type DashScopeTranscriptPostprocessConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

type DashScopeChatCompletionError = {
  code?: number | string;
  message?: string;
};

type DashScopeChatCompletionPayload = {
  choices?: Array<{
    delta?: { content?: unknown };
    message?: { content?: unknown };
  }>;
  error?: DashScopeChatCompletionError;
};

type PostprocessedSegmentText = {
  id: number;
  text: string;
};

export const TRANSCRIPT_POSTPROCESS_VERSION = "qwen-transcript-postprocess-v2";

const POSTPROCESS_REQUEST_TIMEOUT_MS = 120_000;

export async function streamQwenTranscriptPostprocess(input: {
  content: string;
  segments?: TranscriptSegment[];
  signal?: AbortSignal;
}): Promise<ProviderResult> {
  const promptSegments = buildPromptSegments(input);
  if (promptSegments.length === 0) {
    return { ok: false, code: "unavailable", detail: "没有可后处理的转录文本。" };
  }

  try {
    const config = readDashScopeTranscriptPostprocessConfig();
    const prompt = buildTranscriptPostprocessPrompt(promptSegments);

    const response = await callQwenTranscriptPostprocess(config, prompt, input.signal);
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as DashScopeChatCompletionPayload | null;
      return readPostprocessFailure(response, payload) ?? {
        ok: false,
        code: "error",
        detail: formatPostprocessError(response.status, undefined),
      };
    }
    if (!response.body) {
      return { ok: false, code: "unavailable", detail: "Qwen 转录后处理没有返回流式内容。" };
    }

    let output = "";
    for await (const payload of readSseJsonStream<DashScopeChatCompletionPayload>(response.body)) {
      throwIfAborted(input.signal);
      if (payload.error) {
        return {
          ok: false,
          code: "error",
          detail: formatPostprocessError(response.status, payload.error),
        };
      }

      const delta = payload.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        output += delta;
      }
    }

    return buildPostprocessedTranscript(promptSegments, input.segments, output);
  } catch (error) {
    return formatPostprocessThrownError(error);
  }
}

async function callQwenTranscriptPostprocess(
  config: DashScopeTranscriptPostprocessConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<Response> {
  return await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      stream: true,
      stream_options: { include_usage: false },
      temperature: 0,
    }),
    retry: {
      attempts: 2,
      timeoutMs: POSTPROCESS_REQUEST_TIMEOUT_MS,
    },
    signal,
  });
}

function buildPromptSegments(transcript: { content: string; segments?: TranscriptSegment[] }): TimestampedPromptSegment[] {
  const promptSegments = transcript.segments?.map((segment, index): TimestampedPromptSegment => ({
    id: index,
    startSeconds: roundSeconds(segment.startSeconds),
    endSeconds: roundSeconds(segment.endSeconds),
    text: segment.text,
  }));

  if (promptSegments?.some((segment) => segment.text)) {
    return promptSegments;
  }

  const text = transcript.content.trim();
  return text ? [{ id: 0, startSeconds: 0, endSeconds: 0, text }] : [];
}

function buildPostprocessedTranscript(
  sourceSegments: TimestampedPromptSegment[],
  originalSegments: TranscriptSegment[] | undefined,
  output: string,
): ProviderResult {
  const texts = parsePostprocessedSegmentTexts(output, sourceSegments.length);
  if (!texts) {
    return { ok: false, code: "error", detail: "Qwen 转录后处理返回格式无效，请重试。" };
  }

  const transcriptSegments = sourceSegments
    .map((segment, index): TranscriptSegment | null => {
      const text = texts[index]?.text.trim() ?? "";
      if (!text) {
        return null;
      }

      const originalSegment = originalSegments?.[index];
      return {
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        ...(originalSegment?.speakerId ? { speakerId: originalSegment.speakerId } : {}),
        ...(originalSegment?.emotion ? { emotion: originalSegment.emotion } : {}),
        text,
      };
    })
    .filter((segment): segment is TranscriptSegment => Boolean(segment));
  const content = joinPostprocessedTranscriptText(transcriptSegments);

  if (!content) {
    return { ok: false, code: "unavailable", detail: "Qwen 转录后处理没有返回可用文本。" };
  }

  const emotions = [...new Set(transcriptSegments.map((segment) => segment.emotion).filter((emotion): emotion is string => Boolean(emotion)))];
  return {
    ok: true,
    content,
    postprocessVersion: TRANSCRIPT_POSTPROCESS_VERSION,
    transcriptSegments,
    ...(emotions.length ? { emotions } : {}),
  };
}

function parsePostprocessedSegmentTexts(output: string, expectedLength: number): PostprocessedSegmentText[] | null {
  const jsonText = output.trim();
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
      return null;
    }

    const normalized = parsed.map((item): PostprocessedSegmentText | null => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      return typeof record.id === "number" && typeof record.text === "string"
        ? { id: record.id, text: record.text }
        : null;
    });
    if (normalized.some((item) => item === null)) {
      return null;
    }

    const sorted = normalized as PostprocessedSegmentText[];
    return sorted.every((item, index) => item.id === index) ? sorted : null;
  } catch {
    return null;
  }
}

function readDashScopeTranscriptPostprocessConfig(): DashScopeTranscriptPostprocessConfig {
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("DASHSCOPE_API_KEY 未配置。");
  }

  return {
    apiKey,
    baseUrl: readDashScopeCompatibleBaseUrl(),
    model: readRequiredEnv("DASHSCOPE_TRANSCRIPT_POSTPROCESS_MODEL"),
  };
}

function readDashScopeCompatibleBaseUrl(): string {
  const baseUrl = process.env.DASHSCOPE_TRANSLATION_BASE_URL?.trim().replace(/\/+$/u, "");
  if (!baseUrl) {
    throw new Error("DASHSCOPE_TRANSLATION_BASE_URL 未配置。");
  }
  return baseUrl;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 未配置。`);
  }
  return value;
}

function readPostprocessFailure(
  response: Response,
  payload: DashScopeChatCompletionPayload | null,
): ProviderResult | null {
  if (payload?.error) {
    return {
      ok: false,
      code: response.status === 401 || response.status === 403 ? "not_configured" : "error",
      detail: formatPostprocessError(response.status, payload.error),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: response.status === 401 || response.status === 403 ? "not_configured" : "error",
      detail: formatPostprocessError(response.status, undefined),
    };
  }

  return null;
}

function formatPostprocessThrownError(error: unknown): ProviderResult {
  if (isAbortError(error)) {
    return { ok: false, code: "error", detail: "转录任务已放弃。" };
  }
  if (error instanceof Error) {
    if (/DASHSCOPE_(?:API_KEY|TRANSLATION_BASE_URL|TRANSCRIPT_POSTPROCESS_MODEL)/.test(error.message)) {
      return { ok: false, code: "not_configured", detail: error.message };
    }
    if (error.name === "AbortError" || /timeout|timed out/i.test(error.message)) {
      return { ok: false, code: "unavailable", detail: "Qwen 转录后处理响应超时，请稍后再试。" };
    }
    return { ok: false, code: "error", detail: error.message };
  }

  return { ok: false, code: "error", detail: "Qwen 转录后处理失败。" };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function formatPostprocessError(
  httpStatus: number,
  error: DashScopeChatCompletionError | undefined,
): string {
  const status = error?.code ?? httpStatus;
  const message = error?.message;

  if (status === 401) {
    return "DashScope 认证失败：请检查 DASHSCOPE_API_KEY 是否有效。";
  }
  if (status === 403) {
    return "DashScope 拒绝访问：当前 API Key 没有 Qwen 转录后处理模型调用权限。";
  }
  if (status === 429) {
    return "DashScope 请求过于频繁，请稍后重试。";
  }

  return message ?? `Qwen 转录后处理请求失败：HTTP ${httpStatus}`;
}

function roundSeconds(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

function joinPostprocessedTranscriptText(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .reduce((content, text) => {
      if (!content) {
        return text;
      }
      return `${content}${/[A-Za-z0-9]$/.test(content) && /^[A-Za-z0-9]/.test(text) ? " " : "\n"}${text}`;
    }, "");
}
