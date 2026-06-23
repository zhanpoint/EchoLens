export const DOUYIN_KINDS = ["video", "note", "article"] as const;
export const MEDIA_ASSET_KINDS = ["cover", "video", "originalAudio"] as const;
export const EXTRACTION_FEATURES = [
  "cover",
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

export type MediaAsset = {
  kind: MediaAssetKind;
  label: string;
  previewUrl?: string;
  url: string;
};

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
  assets?: MediaAsset[];
  detail?: string;
  transcriptSegments?: TranscriptSegment[];
};

export type ExtractResponse = {
  work: ResolvedDouyinWork;
  results: ExtractionResult[];
};

export const FEATURES_BY_KIND: Record<DouyinKind, ExtractionFeature[]> = {
  video: ["cover", "caption", "originalTranscript"],
  note: ["cover", "caption", "imageContent"],
  article: ["cover", "caption", "articleText"],
};

export const FEATURE_LABELS: Record<ExtractionFeature, string> = {
  cover: "封面",
  caption: "标题",
  originalTranscript: "视频文案",
  imageContent: "图片文字",
  articleText: "文章内容",
};

export function getFeatureLabel(feature: ExtractionFeature): string {
  return FEATURE_LABELS[feature];
}
