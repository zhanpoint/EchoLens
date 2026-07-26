export const DOUYIN_KINDS = ["video"] as const;
export const MEDIA_ASSET_KINDS = ["cover", "video", "originalAudio"] as const;
export const TRANSCRIPT_FEATURE = "audioTranscript" as const;

export type DouyinKind = (typeof DOUYIN_KINDS)[number];
export type TranscriptFeature = typeof TRANSCRIPT_FEATURE;
export type ResultFeature = TranscriptFeature;
export type ExtractionStatus =
  | "success"
  | "unavailable"
  | "not_configured"
  | "no_speech"
  | "error";
export type ExtractionSource = "dashscope" | "detail";
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];

export type TranscriptSegment = {
  endSeconds: number;
  emotion?: string;
  speakerId?: string;
  startSeconds: number;
  text: string;
};

export type DouyinWorkIdentity = {
  inputUrl: string;
  finalUrl: string;
  kind: DouyinKind;
  id: string;
};

export type ResolvedDouyinWork = DouyinWorkIdentity & {
  authorName?: string;
  authorAvatarUrl?: string;
  authorUrl?: string;
  caption: string;
  durationSeconds?: number;
};

export type ExtractionResult = {
  asrModel?: string;
  feature: ResultFeature;
  label: string;
  status: ExtractionStatus;
  source?: ExtractionSource;
  content?: string;
  detail?: string;
  emotions?: string[];
  transcriptSegments?: TranscriptSegment[];
};

export const FEATURE_LABELS: Record<ResultFeature, string> = {
  audioTranscript: "转录文本",
};

export function getFeatureLabel(feature: ResultFeature): string {
  return FEATURE_LABELS[feature];
}
