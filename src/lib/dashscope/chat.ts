import type { ProviderResult } from "@/lib/ai/provider-result";
import {
  fetchWithRetry,
  isRetryableHttpStatus,
  isRetryableNetworkError,
  NetworkRetryExhaustedError,
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  retryOperation,
} from "@/lib/http/retry";
import { readSseJsonStream } from "@/lib/http/sse";
import {
  DASHSCOPE_FIXED_COMPATIBLE_BASE_URL,
} from "@/lib/dashscope/fixed-config";

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

const CHAT_REQUEST_TIMEOUT_MS = 120_000;
export async function streamDashScopeChat(input: {
  apiKey?: string;
  model: string;
  onDelta?: (delta: string) => void;
  onReset?: () => void;
  prompt: string;
  signal?: AbortSignal;
}): Promise<ProviderResult> {
  try {
    const config = readDashScopeChatConfig(input.apiKey, input.model);
    return await streamDashScopeChatCompletion({
      config,
      prompt: input.prompt,
      onDelta: input.onDelta,
      onReset: input.onReset,
      signal: input.signal,
      timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
      extraBody: {
        temperature: 0,
        enable_thinking: false,
      },
      emptyBodyDetail: "模型没有返回流式内容。",
      emptyContentDetail: "模型没有返回可用文本。",
      formatError: formatDashScopeChatError,
    });
  } catch (error) {
    return formatDashScopeChatThrownError(error);
  }
}

export async function streamDashScopeChatCompletion(input: {
  config: DashScopeChatConfig;
  contentMode?: "cumulative" | "incremental";
  emptyBodyDetail: string;
  emptyContentDetail: string;
  extraBody?: Record<string, unknown>;
  formatError: DashScopeChatErrorFormatter;
  onDelta?: (delta: string) => void;
  onReset?: () => void;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<ProviderResult> {
  try {
    return await retryOperation(
      async (attempt) => {
        if (attempt > 1) input.onReset?.();
        return await streamDashScopeChatAttempt(input);
      },
      {
        signal: input.signal,
        shouldRetry: (error) => error instanceof RetryableChatResponseError || isRetryableNetworkError(error),
      },
    );
  } catch (error) {
    if (error instanceof NetworkRetryExhaustedError && error.cause instanceof RetryableChatResponseError) {
      return error.cause.result;
    }
    throw error;
  }
}

class RetryableChatResponseError extends Error {
  constructor(readonly result: Extract<ProviderResult, { ok: false }>) {
    super(result.detail);
  }
}

async function streamDashScopeChatAttempt(input: {
  config: DashScopeChatConfig;
  contentMode?: "cumulative" | "incremental";
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
      attempts: 1,
      timeoutMs: input.timeoutMs,
    },
    signal: input.signal,
  });
  if (!response.ok) {
    const payload = await readDashScopeChatJsonResponse(response);
    const failure = readDashScopeChatFailure(response, payload, input.formatError);
    if (!failure.ok && isRetryableHttpStatus(response.status)) {
      throw new RetryableChatResponseError(failure);
    }
    return failure;
  }
  if (!response.body) {
    return { ok: false, code: "unavailable", detail: input.emptyBodyDetail };
  }

  let completed = false;
  let output = "";
  for await (const payload of readSseJsonStream<DashScopeChatCompletionPayload>(response.body, {
    onDone: () => {
      completed = true;
    },
  })) {
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
      if (input.contentMode === "cumulative") {
        const appended = delta.startsWith(output) ? delta.slice(output.length) : "";
        output = delta;
        if (appended) {
          input.onDelta?.(appended);
        }
      } else {
        output += delta;
        input.onDelta?.(delta);
      }
    }
  }

  if (!completed) {
    throw new Error("SSE stream terminated before [DONE]");
  }
  if (!output.trim()) {
    return { ok: false, code: "unavailable", detail: input.emptyContentDetail };
  }

  return { ok: true, content: output.trim() };
}

function readDashScopeChatConfig(apiKey: string | undefined, model: string): DashScopeChatConfig {
  return {
    apiKey: apiKey?.trim() || readRequiredEnv("DASHSCOPE_API_KEY"),
    baseUrl: DASHSCOPE_FIXED_COMPATIBLE_BASE_URL,
    model,
  };
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
  if (error instanceof NetworkRetryExhaustedError) {
    return { ok: false, code: NETWORK_RETRY_ERROR_CODE, detail: NETWORK_RETRY_ERROR_MESSAGE };
  }
  if (error instanceof Error) {
    if (/DASHSCOPE_API_KEY/.test(error.message)) {
      return { ok: false, code: "not_configured", detail: error.message };
    }
    if (error.name === "AbortError" || /timeout|timed out/i.test(error.message)) {
      return { ok: false, code: "unavailable", detail: "模型响应超时，请稍后再试。" };
    }
    return { ok: false, code: "error", detail: error.message };
  }

  return { ok: false, code: "error", detail: "模型请求失败。" };
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
    return "DashScope 拒绝访问：当前 API Key 没有所选模型的调用权限。";
  }
  if (status === 429) {
    return "DashScope 请求过于频繁，请稍后重试。";
  }

  return message ?? `模型请求失败：HTTP ${httpStatus}`;
}
