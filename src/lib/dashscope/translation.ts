import type { ProviderResult } from "@/lib/ai/provider-result";
import { fetchWithRetry } from "@/lib/http/retry";
import { readSseJsonStream } from "@/lib/http/sse";

export type QwenMtTerm = {
  source: string;
  target: string;
};

export type QwenMtTranslationOptions = {
  domains?: string;
  source_lang: "auto";
  target_lang: string;
  terms?: QwenMtTerm[];
  tm_list?: QwenMtTerm[];
};

type DashScopeTranslationConfig = {
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

const DEFAULT_QWEN_MT_MODEL = "qwen-mt-flash";
const QWEN_MT_REQUEST_TIMEOUT_MS = 90_000;
const QWEN_MT_TEXT_LIMIT = 24_000;
const QWEN_MT_REFERENCE_TEXT_LIMIT = 16_000;

export async function streamQwenMtText(input: {
  onDelta: (delta: string) => void;
  options: QwenMtTranslationOptions;
  text: string;
}): Promise<ProviderResult> {
  const text = normalizeTranslationText(input.text);
  if (!text) {
    return { ok: false, code: "unavailable", detail: "没有可翻译的文本。" };
  }

  try {
    const options = normalizeTranslationOptions(input.options);
    if (!options.target_lang) {
      return { ok: false, code: "unavailable", detail: "请选择目标语言。" };
    }

    assertTranslationPayloadWithinLimit(text, options);
    const config = readDashScopeTranslationConfig();
    const response = await callQwenMt(config, text, options);
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as DashScopeChatCompletionPayload | null;
      return readQwenMtFailure(response, payload) ?? {
        ok: false,
        code: "error",
        detail: formatQwenMtError(response.status, undefined),
      };
    }
    if (!response.body) {
      return { ok: false, code: "unavailable", detail: "Qwen-MT 没有返回流式内容。" };
    }

    let output = "";
    for await (const payload of readSseJsonStream<DashScopeChatCompletionPayload>(response.body)) {
      const delta = payload.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        output += delta;
        input.onDelta(delta);
      }
    }

    if (!output.trim()) {
      return { ok: false, code: "unavailable", detail: "Qwen-MT 没有返回可用译文。" };
    }

    return { ok: true, content: output.trim() };
  } catch (error) {
    return formatQwenMtThrownError(error);
  }
}

async function callQwenMt(
  config: DashScopeTranslationConfig,
  text: string,
  options: QwenMtTranslationOptions,
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
          content: text,
        },
      ],
      stream: true,
      stream_options: { include_usage: false },
      translation_options: normalizeTranslationOptions(options),
    }),
    retry: {
      attempts: 2,
      timeoutMs: QWEN_MT_REQUEST_TIMEOUT_MS,
    },
  });
}

function normalizeTranslationText(text: string): string {
  return text.trim();
}

function normalizeTranslationOptions(options: QwenMtTranslationOptions): QwenMtTranslationOptions {
  return {
    source_lang: "auto",
    target_lang: options.target_lang.trim(),
    ...(options.domains?.trim() ? { domains: options.domains.trim() } : {}),
    ...(options.terms?.length ? { terms: normalizePairs(options.terms) } : {}),
    ...(options.tm_list?.length ? { tm_list: normalizePairs(options.tm_list) } : {}),
  };
}

function normalizePairs(pairs: QwenMtTerm[]): QwenMtTerm[] {
  return pairs
    .map((pair) => ({
      source: pair.source.trim(),
      target: pair.target.trim(),
    }))
    .filter((pair) => pair.source && pair.target);
}

function assertTranslationPayloadWithinLimit(text: string, options: QwenMtTranslationOptions): void {
  if (text.length > QWEN_MT_TEXT_LIMIT) {
    throw new Error("待翻译文本过长，请按段落或完整句子拆分后再翻译。");
  }

  const referenceLength = [
    options.domains ?? "",
    ...(options.terms ?? []).flatMap((pair) => [pair.source, pair.target]),
    ...(options.tm_list ?? []).flatMap((pair) => [pair.source, pair.target]),
  ].reduce((sum, value) => sum + value.length, 0);
  if (referenceLength > QWEN_MT_REFERENCE_TEXT_LIMIT) {
    throw new Error("术语、翻译记忆或领域提示过长，请只保留与当前文本直接相关的参考内容。");
  }
}

function readDashScopeTranslationConfig(): DashScopeTranslationConfig {
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("DASHSCOPE_API_KEY 未配置。");
  }

  return {
    apiKey,
    baseUrl: readDashScopeTranslationBaseUrl(),
    model: process.env.DASHSCOPE_TRANSLATION_MODEL?.trim() || DEFAULT_QWEN_MT_MODEL,
  };
}

function readDashScopeTranslationBaseUrl(): string {
  const baseUrl = process.env.DASHSCOPE_TRANSLATION_BASE_URL?.trim().replace(/\/+$/u, "");
  if (!baseUrl) {
    throw new Error("DASHSCOPE_TRANSLATION_BASE_URL 未配置。");
  }
  return baseUrl;
}

function readQwenMtFailure(
  response: Response,
  payload: DashScopeChatCompletionPayload | null,
): ProviderResult | null {
  if (payload?.error) {
    return {
      ok: false,
      code: response.status === 401 || response.status === 403 ? "not_configured" : "error",
      detail: formatQwenMtError(response.status, payload.error),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: response.status === 401 || response.status === 403 ? "not_configured" : "error",
      detail: formatQwenMtError(response.status, undefined),
    };
  }
  return null;
}

function formatQwenMtThrownError(error: unknown): ProviderResult {
  if (error instanceof Error) {
    if (/DASHSCOPE_(?:API_KEY|TRANSLATION_BASE_URL)/.test(error.message)) {
      return { ok: false, code: "not_configured", detail: error.message };
    }
    if (error.name === "AbortError" || /timeout|timed out/i.test(error.message)) {
      return { ok: false, code: "unavailable", detail: "Qwen-MT 响应超时，请稍后再试。" };
    }
    return { ok: false, code: "error", detail: error.message };
  }

  return { ok: false, code: "error", detail: "Qwen-MT 翻译失败。" };
}

function formatQwenMtError(
  httpStatus: number,
  error: DashScopeChatCompletionError | undefined,
): string {
  const status = error?.code ?? httpStatus;
  const message = error?.message;

  if (status === 401) {
    return "DashScope 认证失败：请检查 DASHSCOPE_API_KEY 是否有效。";
  }
  if (status === 403) {
    return "DashScope 拒绝访问：当前 API Key 没有 Qwen-MT 调用权限。";
  }
  if (status === 429) {
    return "DashScope 请求过于频繁，请稍后重试。";
  }

  return message ?? `Qwen-MT 请求失败：HTTP ${httpStatus}`;
}
