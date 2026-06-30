import type { TranscriptSegment } from "@/types/douyin";

export type ProviderResult =
  | { asrModel?: string; emotions?: string[]; ok: true; content: string; transcriptSegments?: TranscriptSegment[] }
  | { ok: false; code: "not_configured" | "unavailable" | "error"; detail: string };
