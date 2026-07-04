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

export const TRANSCRIPT_POSTPROCESS_VERSION = "qwen3.5-flash-boundary-v1";

const DEFAULT_TRANSCRIPT_POSTPROCESS_MODEL = "qwen3.5-flash";
const POSTPROCESS_REQUEST_TIMEOUT_MS = 120_000;
const POSTPROCESS_INPUT_LIMIT = 200_000;
const POSTPROCESS_MAX_TOKENS = 32_768;

export async function streamQwenTranscriptPostprocess(input: {
  content: string;
  onDelta: (delta: string) => void;
  segments?: TranscriptSegment[];
}): Promise<ProviderResult> {
  const promptSegments = buildPromptSegments(input.content, input.segments);
  if (promptSegments.length === 0) {
    return { ok: false, code: "unavailable", detail: "没有可后处理的转录文本。" };
  }

  try {
    const config = readDashScopeTranscriptPostprocessConfig();
    const prompt = buildTranscriptPostprocessPrompt(promptSegments);
    assertPostprocessPayloadWithinLimit(prompt);

    const response = await callQwenTranscriptPostprocess(config, prompt);
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
        input.onDelta(delta);
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
      max_tokens: POSTPROCESS_MAX_TOKENS,
    }),
    retry: {
      attempts: 2,
      timeoutMs: POSTPROCESS_REQUEST_TIMEOUT_MS,
    },
  });
}

function buildPromptSegments(content: string, segments: TranscriptSegment[] | undefined): TimestampedPromptSegment[] {
  const promptSegments = segments?.map((segment, index): TimestampedPromptSegment => ({
    id: index,
    startSeconds: roundSeconds(segment.startSeconds),
    endSeconds: roundSeconds(segment.endSeconds),
    text: segment.text.trim(),
  }));

  if (promptSegments?.some((segment) => segment.text)) {
    return promptSegments;
  }

  const text = content.trim();
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
  const content = joinTranscriptText(transcriptSegments.map((segment) => segment.text));

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
  const jsonText = extractJsonArrayText(output.trim());
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

function extractJsonArrayText(value: string): string | null {
  const withoutFence = value
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  if (withoutFence.startsWith("[") && withoutFence.endsWith("]")) {
    return withoutFence;
  }

  const start = withoutFence.indexOf("[");
  const end = withoutFence.lastIndexOf("]");
  return start >= 0 && end > start ? withoutFence.slice(start, end + 1) : null;
}

function assertPostprocessPayloadWithinLimit(prompt: string): void {
  if (prompt.length > POSTPROCESS_INPUT_LIMIT) {
    throw new Error("转录文本过长，暂不支持一次性进行 AI 后处理。");
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
    model: process.env.DASHSCOPE_TRANSCRIPT_POSTPROCESS_MODEL?.trim() || DEFAULT_TRANSCRIPT_POSTPROCESS_MODEL,
  };
}

function readDashScopeCompatibleBaseUrl(): string {
  const baseUrl = process.env.DASHSCOPE_TRANSLATION_BASE_URL?.trim().replace(/\/+$/u, "");
  if (!baseUrl) {
    throw new Error("DASHSCOPE_TRANSLATION_BASE_URL 未配置。");
  }
  return baseUrl;
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
  if (error instanceof Error) {
    if (/DASHSCOPE_(?:API_KEY|TRANSLATION_BASE_URL)/.test(error.message)) {
      return { ok: false, code: "not_configured", detail: error.message };
    }
    if (error.name === "AbortError" || /timeout|timed out/i.test(error.message)) {
      return { ok: false, code: "unavailable", detail: "Qwen 转录后处理响应超时，请稍后再试。" };
    }
    return { ok: false, code: "error", detail: error.message };
  }

  return { ok: false, code: "error", detail: "Qwen 转录后处理失败。" };
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

function joinTranscriptText(parts: string[]): string {
  return parts
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .reduce((content, part) => {
      if (!content) {
        return part;
      }
      return `${content}${needsWordBoundary(content, part) ? " " : "\n"}${part}`;
    }, "");
}

function needsWordBoundary(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

function roundSeconds(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}
