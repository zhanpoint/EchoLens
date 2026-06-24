export const DOUYIN_KINDS = ["video", "note", "article"] as const;
export const MEDIA_ASSET_KINDS = ["cover", "video", "originalAudio"] as const;
export const EXTRACTION_FEATURES = [
  "caption",
  "originalTranscript",
  "imageContent",
  "articleText",
] as const;

export type DouyinKind = (typeof DOUYIN_KINDS)[number];
export type ExtractionFeature = (typeof EXTRACTION_FEATURES)[number];
export type ExtractionStatus =
  | "success"
  | "unavailable"
  | "not_configured"
  | "error";
export type ExtractionSource = "detail" | "openrouter";
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];

export type TranscriptSegment = {
  endSeconds: number;
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
};

export type ExtractionResult = {
  feature: ExtractionFeature;
  label: string;
  status: ExtractionStatus;
  source?: ExtractionSource;
  content?: string;
  detail?: string;
  transcriptSegments?: TranscriptSegment[];
};

export type ExtractResponse = {
  work: ResolvedDouyinWork;
  results: ExtractionResult[];
};

export const FEATURES_BY_KIND: Record<DouyinKind, ExtractionFeature[]> = {
  video: ["caption", "originalTranscript"],
  note: ["caption", "imageContent"],
  article: ["caption", "articleText"],
};

export const FEATURE_LABELS: Record<ExtractionFeature, string> = {
  caption: "标题",
  originalTranscript: "视频文案",
  imageContent: "图片文字",
  articleText: "文章内容",
};

export function getFeatureLabel(feature: ExtractionFeature): string {
  return FEATURE_LABELS[feature];
}
