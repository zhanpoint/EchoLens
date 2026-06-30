import type { ProviderResult } from "@/lib/ai/provider-result";
import { fetchWithRetry } from "@/lib/http/retry";

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenRouterError = {
  code?: number;
  message?: string;
  metadata?: Record<string, unknown>;
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
  const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: "POST",
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
    retry: { timeoutMs: OPENROUTER_REQUEST_TIMEOUT_MS },
  })
    .catch((error: unknown) => {
      throw new Error(formatOpenRouterNetworkError(error));
    });

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
