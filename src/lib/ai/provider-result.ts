import type { TranscriptSegment } from "@/types/douyin";

export type ProviderResult =
  | { asrModel?: string; emotions?: string[]; ok: true; content: string; postprocessVersion?: string; transcriptSegments?: TranscriptSegment[] }
  | { ok: false; code: "not_configured" | "unavailable" | "no_speech" | "invalid_response" | "error" | "NETWORK_RETRY_EXHAUSTED"; detail: string };
