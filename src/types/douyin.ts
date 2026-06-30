export const DOUYIN_KINDS = ["video", "note", "article"] as const;
export const MEDIA_ASSET_KINDS = ["cover", "video", "originalAudio"] as const;
export const EXTRACTION_FEATURES = [
  "imageContent",
  "articleText",
] as const;
export const TRANSCRIPT_FEATURE = "audioTranscript" as const;

export type DouyinKind = (typeof DOUYIN_KINDS)[number];
export type ExtractionFeature = (typeof EXTRACTION_FEATURES)[number];
export type TranscriptFeature = typeof TRANSCRIPT_FEATURE;
export type ResultFeature = ExtractionFeature | TranscriptFeature;
export type ExtractionStatus =
  | "success"
  | "unavailable"
  | "not_configured"
  | "error";
export type ExtractionSource = "dashscope" | "detail" | "openrouter";
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];

export type TranscriptSegment = {
  endSeconds: number;
  emotion?: string;
  speakerId?: string;
  startSeconds: number;
  text: string;
};

export type ResolvedDouyinWork = {
  inputUrl: string;
  finalUrl: string;
  kind: DouyinKind;
  id: string;
  authorName?: string;
  authorUrl?: string;
  durationSeconds?: number;
  title?: string;
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

export type DouyinProcessResponse = {
  work: ResolvedDouyinWork;
  results: ExtractionResult[];
};

export const FEATURES_BY_KIND: Record<DouyinKind, ExtractionFeature[]> = {
  video: [],
  note: ["imageContent"],
  article: ["articleText"],
};

export const FEATURE_LABELS: Record<ResultFeature, string> = {
  audioTranscript: "转录文本",
  imageContent: "图片文字",
  articleText: "文章内容",
};

export function getFeatureLabel(feature: ResultFeature): string {
  return FEATURE_LABELS[feature];
}
