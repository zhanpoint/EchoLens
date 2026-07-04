import type { ProviderResult } from "@/lib/ai/provider-result";
import { buildSummaryPromptContent } from "@/lib/ai/prompts";
import { fetchWithRetry } from "@/lib/http/retry";
import { readSseJsonStream } from "@/lib/http/sse";

type OpenRouterError = {
  code?: number;
  message?: string;
  metadata?: Record<string, unknown>;
};

type OpenRouterChatPayload = {
  choices?: Array<{
    delta?: { content?: unknown };
    message?: { content?: unknown };
  }>;
  error?: OpenRouterError;
};

type OpenRouterConfig = {
  apiKey: string;
  baseUrl: string;
};

const OPENROUTER_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SUMMARY_MODEL = "deepseek/deepseek-v4-flash";

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
    buildSummaryPromptContent(text, instruction),
    {
      model: process.env.OPENROUTER_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL,
    },
  );
}

export async function streamSummarizeTranscript(input: {
  onDelta: (delta: string) => void;
  prompt: string;
  transcript: string;
}): Promise<ProviderResult> {
  const text = input.transcript.trim();
  const instruction = input.prompt.trim();
  if (!text) {
    return { ok: false, code: "unavailable", detail: "没有可总结的转写文本。" };
  }
  if (!instruction) {
    return { ok: false, code: "unavailable", detail: "请选择或填写总结提示词。" };
  }

  try {
    const config = readOpenRouterConfig();
    const response = await callOpenRouterChatCompletions(
      config,
      buildSummaryPromptContent(text, instruction),
      {
        model: process.env.OPENROUTER_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL,
        stream: true,
      },
    )
      .catch((error: unknown) => {
        throw new Error(formatOpenRouterNetworkError(error));
      });

    if (!response.ok) {
      const payload = await readOpenRouterJsonResponse(response);
      return readOpenRouterFailure(response, payload) ?? {
        ok: false,
        code: "error",
        detail: formatOpenRouterError(response.status, undefined),
      };
    }
    if (!response.body) {
      return { ok: false, code: "unavailable", detail: "OpenRouter 没有返回流式内容。" };
    }

    let output = "";
    for await (const payload of readSseJsonStream<OpenRouterChatPayload>(response.body)) {
      if (payload.error) {
        return {
          ok: false,
          code: "error",
          detail: formatOpenRouterError(response.status, payload.error),
        };
      }

      const delta = payload.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        output += delta;
        input.onDelta(delta);
      }
    }

    if (!output.trim()) {
      return { ok: false, code: "unavailable", detail: "模型没有返回可用文本。" };
    }

    return { ok: true, content: output.trim() };
  } catch (error) {
    return formatOpenRouterThrownError(error);
  }
}

async function callOpenRouter(
  content: string,
  options: { model: string },
): Promise<ProviderResult> {
  let config: OpenRouterConfig;
  try {
    config = readOpenRouterConfig();
  } catch (error) {
    return formatOpenRouterThrownError(error);
  }

  const response = await callOpenRouterChatCompletions(config, content, {
    model: options.model,
  })
    .catch((error: unknown) => {
      throw new Error(formatOpenRouterNetworkError(error));
    });

  const payload = await readOpenRouterJsonResponse(response);
  const failure = readOpenRouterFailure(response, payload);
  if (failure) {
    return failure;
  }

  const contentText = payload?.choices?.[0]?.message?.content;
  if (typeof contentText !== "string" || !contentText.trim()) {
    return { ok: false, code: "unavailable", detail: "模型没有返回可用文本。" };
  }

  return { ok: true, content: contentText.trim() };
}

async function callOpenRouterChatCompletions(
  config: OpenRouterConfig,
  content: string,
  options: { model: string; stream?: boolean },
): Promise<Response> {
  return await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      "http-referer": "https://echolens.local",
      "x-title": "EchoLens",
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        {
          role: "user",
          content,
        },
      ],
      ...(options.stream ? { stream: true } : {}),
    }),
    retry: { timeoutMs: OPENROUTER_REQUEST_TIMEOUT_MS },
  });
}

function readOpenRouterConfig(): OpenRouterConfig {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY 未配置。");
  }

  return {
    apiKey,
    baseUrl: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
  };
}

async function readOpenRouterJsonResponse(response: Response): Promise<OpenRouterChatPayload | null> {
  return (await response.json().catch(() => null)) as OpenRouterChatPayload | null;
}

function readOpenRouterFailure(
  response: Response,
  payload: OpenRouterChatPayload | null,
): ProviderResult | null {
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

  return null;
}

function formatOpenRouterThrownError(error: unknown): ProviderResult {
  if (error instanceof Error) {
    if (/OPENROUTER_API_KEY/.test(error.message)) {
      return { ok: false, code: "not_configured", detail: error.message };
    }
    if (error.name === "AbortError" || /timeout|timed out/i.test(error.message)) {
      return { ok: false, code: "unavailable", detail: formatOpenRouterNetworkError(error) };
    }
    return { ok: false, code: "error", detail: error.message };
  }

  return { ok: false, code: "error", detail: "OpenRouter 请求失败。" };
}

function formatOpenRouterNetworkError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "AI 服务响应超时，系统已自动重试但仍未完成，请稍后再试。";
  }

  return "AI 服务暂时不可用，系统已自动重试，请稍后再试。";
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
