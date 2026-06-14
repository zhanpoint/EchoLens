export const DOUYIN_KINDS = ["video", "note", "article"] as const;
export const EXTRACTION_FEATURES = [
  "caption",
  "transcript",
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
export type ExtractionSource = "detail" | "public" | "openrouter";

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
};

export type ExtractResponse = {
  work: ResolvedDouyinWork;
  results: ExtractionResult[];
};

export const FEATURES_BY_KIND: Record<DouyinKind, ExtractionFeature[]> = {
  video: ["caption", "transcript"],
  note: ["caption", "imageContent"],
  article: ["caption", "articleText"],
};

export const FEATURE_LABELS: Record<ExtractionFeature, string> = {
  caption: "文案",
  transcript: "转录文本",
  imageContent: "图片文字",
  articleText: "文章内容",
};

export function getFeatureLabel(feature: ExtractionFeature, kind?: DouyinKind): string {
  if (kind === "video" && feature === "caption") {
    return "文案";
  }
  if (kind === "video" && feature === "transcript") {
    return "转录文本";
  }
  if (kind === "article" && feature === "caption") {
    return "文章标题";
  }
  return FEATURE_LABELS[feature];
}
