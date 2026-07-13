import type { ProviderResult } from "@/lib/ai/provider-result";
import { fetchWithRetry } from "@/lib/http/retry";
import { readSseJsonStream } from "@/lib/http/sse";

export type DashScopeChatConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type DashScopeChatCompletionError = {
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

type DashScopeChatErrorFormatter = (
  httpStatus: number,
  error: DashScopeChatCompletionError | undefined,
) => string;

const QWEN_CHAT_REQUEST_TIMEOUT_MS = 120_000;
export async function streamQwenChat(input: {
  onDelta?: (delta: string) => void;
  prompt: string;
  signal?: AbortSignal;
  thinkingEnabled?: boolean;
}): Promise<ProviderResult> {
  try {
    const config = readDashScopeQwenChatConfig();
    return await streamDashScopeChatCompletion({
      config,
      prompt: input.prompt,
      onDelta: input.onDelta,
      signal: input.signal,
      timeoutMs: QWEN_CHAT_REQUEST_TIMEOUT_MS,
      extraBody: {
        temperature: 0,
        ...(input.thinkingEnabled !== undefined ? { enable_thinking: input.thinkingEnabled } : {}),
      },
      emptyBodyDetail: "Qwen 没有返回流式内容。",
      emptyContentDetail: "模型没有返回可用文本。",
      formatError: formatDashScopeChatError,
    });
  } catch (error) {
    return formatDashScopeChatThrownError(error);
  }
}

export async function streamDashScopeChatCompletion(input: {
  config: DashScopeChatConfig;
  emptyBodyDetail: string;
  emptyContentDetail: string;
  extraBody?: Record<string, unknown>;
  formatError: DashScopeChatErrorFormatter;
  onDelta?: (delta: string) => void;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<ProviderResult> {
  const response = await fetchWithRetry(`${input.config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.config.model,
      messages: [
        {
          role: "user",
          content: input.prompt,
        },
      ],
      stream: true,
      stream_options: { include_usage: false },
      ...input.extraBody,
    }),
    retry: {
      attempts: 2,
      timeoutMs: input.timeoutMs,
    },
    signal: input.signal,
  });
  if (!response.ok) {
    const payload = await readDashScopeChatJsonResponse(response);
    return readDashScopeChatFailure(response, payload, input.formatError);
  }
  if (!response.body) {
    return { ok: false, code: "unavailable", detail: input.emptyBodyDetail };
  }

  let output = "";
  for await (const payload of readSseJsonStream<DashScopeChatCompletionPayload>(response.body)) {
    throwIfAborted(input.signal);
    if (payload.error) {
      return {
        ok: false,
        code: "error",
        detail: input.formatError(response.status, payload.error),
      };
    }

    const delta = payload.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      output += delta;
      input.onDelta?.(delta);
    }
  }

  if (!output.trim()) {
    return { ok: false, code: "unavailable", detail: input.emptyContentDetail };
  }

  return { ok: true, content: output.trim() };
}

function readDashScopeQwenChatConfig(): DashScopeChatConfig {
  return {
    apiKey: readRequiredEnv("DASHSCOPE_API_KEY"),
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

async function readDashScopeChatJsonResponse(response: Response): Promise<DashScopeChatCompletionPayload | null> {
  return (await response.json().catch(() => null)) as DashScopeChatCompletionPayload | null;
}

function readDashScopeChatFailure(
  response: Response,
  payload: { error?: DashScopeChatCompletionError } | null,
  formatError: DashScopeChatErrorFormatter,
): ProviderResult {
  if (payload?.error) {
    return {
      ok: false,
      code: response.status === 401 || response.status === 403 ? "not_configured" : "error",
      detail: formatError(response.status, payload.error),
    };
  }

  return {
    ok: false,
    code: response.status === 401 || response.status === 403 ? "not_configured" : "error",
    detail: formatError(response.status, undefined),
  };
}

function formatDashScopeChatThrownError(error: unknown): ProviderResult {
  if (isAbortError(error)) {
    return { ok: false, code: "error", detail: "转录任务已放弃。" };
  }
  if (error instanceof Error) {
    if (/DASHSCOPE_(?:API_KEY|TRANSLATION_BASE_URL|TRANSCRIPT_POSTPROCESS_MODEL)/.test(error.message)) {
      return { ok: false, code: "not_configured", detail: error.message };
    }
    if (error.name === "AbortError" || /timeout|timed out/i.test(error.message)) {
      return { ok: false, code: "unavailable", detail: "Qwen 响应超时，请稍后再试。" };
    }
    return { ok: false, code: "error", detail: error.message };
  }

  return { ok: false, code: "error", detail: "Qwen 请求失败。" };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function formatDashScopeChatError(
  httpStatus: number,
  error: DashScopeChatCompletionError | undefined,
): string {
  const status = error?.code ?? httpStatus;
  const message = error?.message;

  if (status === 401) {
    return "DashScope 认证失败：请检查 DASHSCOPE_API_KEY 是否有效。";
  }
  if (status === 403) {
    return "DashScope 拒绝访问：当前 API Key 没有 Qwen 模型调用权限。";
  }
  if (status === 429) {
    return "DashScope 请求过于频繁，请稍后重试。";
  }

  return message ?? `Qwen 请求失败：HTTP ${httpStatus}`;
}
