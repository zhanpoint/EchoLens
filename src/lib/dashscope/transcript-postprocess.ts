import type { ProviderResult } from "@/lib/ai/provider-result";
import {
  buildTranscriptPostprocessPrompt,
  type TimestampedPromptSegment,
} from "@/lib/ai/prompts";
import { streamDashScopeChat } from "@/lib/dashscope/chat";
import { DEFAULT_DASHSCOPE_MODELS } from "@/lib/dashscope/model-config";
import type { TranscriptSegment } from "@/types/douyin";

type PostprocessedSegmentText = {
  id: number;
  text: string;
};

export const TRANSCRIPT_POSTPROCESS_VERSION = "transcript-postprocess-v8";

export async function streamTranscriptPostprocess(input: {
  apiKey?: string;
  content: string;
  model?: string;
  segments?: TranscriptSegment[];
  signal?: AbortSignal;
  title?: string;
  authorName?: string;
}): Promise<ProviderResult> {
  const promptSegments = buildPromptSegments(input);
  if (promptSegments.length === 0) {
    return { ok: false, code: "unavailable", detail: "没有可后处理的转录文本。" };
  }

  const prompt = buildTranscriptPostprocessPrompt(promptSegments, { authorName: input.authorName, title: input.title });
  const result = await streamDashScopeChat({
    apiKey: input.apiKey,
    model: input.model ?? DEFAULT_DASHSCOPE_MODELS.transcriptPostprocess,
    prompt,
    signal: input.signal,
  });
  if (!result.ok) {
    return result;
  }

  return buildPostprocessedTranscript(promptSegments, input.segments, result.content);
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
    return { ok: false, code: "invalid_response", detail: "转录后处理模型返回格式无效，请重试。" };
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
    return { ok: false, code: "unavailable", detail: "转录后处理模型没有返回可用文本。" };
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
    return null;
  }

  const segments = parsed.map((item, index): PostprocessedSegmentText | null => {
    if (!item || typeof item !== "object") {
      return null;
    }
    const record = item as Record<string, unknown>;
    return record.id === index && typeof record.text === "string"
      ? { id: index, text: record.text }
      : null;
  });
  return segments.some((item) => item === null)
    ? null
    : segments as PostprocessedSegmentText[];
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
