import type { TranscriptSegment } from "@/types/douyin";

const DOUYIN_WATERMARK_TEXTS = new Set(["抖音", "douyin"]);
const WATERMARK_BOUNDARY_PATTERN = /[\s\p{P}\p{S}\u200B-\u200D\uFEFF]+/gu;
const TRAILING_WATERMARK_PATTERN = /(^|[\s\p{P}\p{S}\u200B-\u200D\uFEFF])(?:抖音|douyin)[\s\p{P}\p{S}\u200B-\u200D\uFEFF]*$/iu;

export function isTrailingDouyinWatermarkText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }

  return DOUYIN_WATERMARK_TEXTS.has(text.replace(WATERMARK_BOUNDARY_PATTERN, "").toLocaleLowerCase());
}

export function stripTrailingDouyinWatermarkText(content: string): string {
  return content
    .replace(TRAILING_WATERMARK_PATTERN, (_match, prefix: string) => prefix)
    .trimEnd();
}

export function stripTrailingDouyinWatermarkFromTranscript<
  T extends { content?: string; transcriptSegments?: TranscriptSegment[] },
>(payload: T): T {
  const segments = payload.transcriptSegments;
  const shouldDropLastSegment = isTrailingDouyinWatermarkText(segments?.at(-1)?.text);
  const transcriptSegments = shouldDropLastSegment ? segments?.slice(0, -1) : segments;
  const hasContent = payload.content !== undefined;
  const content = transcriptSegments?.length
    ? joinTranscriptSegmentText(transcriptSegments)
    : hasContent
      ? stripTrailingDouyinWatermarkText(payload.content ?? "")
      : payload.content;

  return {
    ...payload,
    content,
    transcriptSegments,
  };
}

function joinTranscriptSegmentText(segments: TranscriptSegment[]): string {
  return segments.map((segment) => segment.text.trim()).filter(Boolean).join("\n");
}
