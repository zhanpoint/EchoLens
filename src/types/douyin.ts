export const DOUYIN_KINDS = ["video", "note", "article"] as const;
export const MEDIA_ASSET_KINDS = ["cover", "video", "originalAudio", "dubbedAudio"] as const;
export const EXTRACTION_FEATURES = [
  "cover",
  "caption",
  "originalTranscript",
  "dubbedTranscript",
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
  video: ["cover", "caption", "originalTranscript", "dubbedTranscript"],
  note: ["cover", "caption", "dubbedTranscript", "imageContent"],
  article: ["cover", "caption", "articleText", "dubbedTranscript"],
};

export const FEATURE_LABELS: Record<ExtractionFeature, string> = {
  cover: "封面",
  caption: "文案",
  originalTranscript: "原声文本",
  dubbedTranscript: "配音文本",
  imageContent: "图片文字",
  articleText: "文章内容",
};

export function getFeatureLabel(feature: ExtractionFeature, kind?: DouyinKind): string {
  if (kind === "video" && feature === "caption") {
    return "文案";
  }
  if (kind === "video" && feature === "originalTranscript") {
    return "视频原声文本";
  }
  if (feature === "dubbedTranscript") {
    return "配音文本";
  }
  if (kind === "article" && feature === "caption") {
    return "标题";
  }
  return FEATURE_LABELS[feature];
}
