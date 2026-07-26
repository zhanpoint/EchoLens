import type { ProviderResult } from "@/lib/ai/provider-result";
import { buildSummaryPromptContent } from "@/lib/ai/prompts";
import { streamDashScopeChat } from "@/lib/dashscope/chat";
import { DEFAULT_DASHSCOPE_MODELS } from "@/lib/dashscope/model-config";

type SummaryPromptBuildResult =
  | { ok: true; prompt: string }
  | { ok: false; code: "unavailable"; detail: string };

export async function streamSummarizeTranscript(input: {
  apiKey?: string;
  model?: string;
  onDelta: (delta: string) => void;
  onReset?: () => void;
  prompt: string;
  signal?: AbortSignal;
  transcript: string;
}): Promise<ProviderResult> {
  const content = buildSummaryContent(input.transcript, input.prompt);
  if (!content.ok) {
    return content;
  }

  return streamDashScopeChat({
    apiKey: input.apiKey,
    model: input.model ?? DEFAULT_DASHSCOPE_MODELS.summary,
    prompt: content.prompt,
    onDelta: input.onDelta,
    onReset: input.onReset,
    signal: input.signal,
  });
}

function buildSummaryContent(
  transcript: string,
  prompt: string,
): SummaryPromptBuildResult {
  const text = transcript.trim();
  const instruction = prompt.trim();
  if (!text) {
    return { ok: false, code: "unavailable", detail: "没有可总结的转写文本。" };
  }
  if (!instruction) {
    return { ok: false, code: "unavailable", detail: "请选择或填写总结提示词。" };
  }

  return {
    ok: true,
    prompt: buildSummaryPromptContent(text, instruction),
  };
}
