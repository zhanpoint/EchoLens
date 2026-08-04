export const DOWNLOAD_ORGANIZATIONS = ["flat", "fileType", "date", "work", "author"] as const;
export const DOWNLOAD_VIDEO_QUALITIES = [
  "lowest",
  "360p",
  "480p",
  "540p",
  "720p",
  "1080p",
  "1440p",
  "highest",
] as const;
export const BILIBILI_VIDEO_QUALITIES = [
  "lowest",
  "360p",
  "480p",
  "540p",
  "720p",
  "1080p",
  "1440p",
  "2160p",
  "4320p",
  "highest",
] as const;
export const BILIBILI_VIDEO_CODECS = ["avc", "hevc", "av1"] as const;
export const BILIBILI_AUDIO_QUALITIES = ["lowest", "64k", "132k", "192k", "hiRes", "dolby", "highest"] as const;
export const BILIBILI_STREAM_FORMATS = ["dashFull", "dashBasic"] as const;

export type DownloadOrganization = (typeof DOWNLOAD_ORGANIZATIONS)[number];
export type DownloadVideoQuality = (typeof DOWNLOAD_VIDEO_QUALITIES)[number];
export type BilibiliVideoQuality = (typeof BILIBILI_VIDEO_QUALITIES)[number];
export type BilibiliVideoCodec = (typeof BILIBILI_VIDEO_CODECS)[number];
export type BilibiliAudioQuality = (typeof BILIBILI_AUDIO_QUALITIES)[number];
export type BilibiliStreamFormat = (typeof BILIBILI_STREAM_FORMATS)[number];

export const DEFAULT_DOWNLOAD_ORGANIZATION: DownloadOrganization = "work";
export const DEFAULT_DOWNLOAD_VIDEO_QUALITY: DownloadVideoQuality = "lowest";
export const DEFAULT_BILIBILI_VIDEO_QUALITY: BilibiliVideoQuality = "lowest";
export const DEFAULT_BILIBILI_VIDEO_CODEC: BilibiliVideoCodec = "avc";
export const DEFAULT_BILIBILI_AUDIO_QUALITY: BilibiliAudioQuality = "lowest";
export const DEFAULT_BILIBILI_STREAM_FORMAT: BilibiliStreamFormat = "dashFull";

const DOWNLOAD_ORGANIZATION_SET = new Set<string>(DOWNLOAD_ORGANIZATIONS);
const DOWNLOAD_VIDEO_QUALITY_SET = new Set<string>(DOWNLOAD_VIDEO_QUALITIES);
const BILIBILI_VIDEO_QUALITY_SET = new Set<string>(BILIBILI_VIDEO_QUALITIES);
const BILIBILI_VIDEO_CODEC_SET = new Set<string>(BILIBILI_VIDEO_CODECS);
const BILIBILI_AUDIO_QUALITY_SET = new Set<string>(BILIBILI_AUDIO_QUALITIES);
const BILIBILI_STREAM_FORMAT_SET = new Set<string>(BILIBILI_STREAM_FORMATS);

export function isDownloadOrganization(value: unknown): value is DownloadOrganization {
  return typeof value === "string" && DOWNLOAD_ORGANIZATION_SET.has(value);
}

export function isDownloadVideoQuality(value: unknown): value is DownloadVideoQuality {
  return typeof value === "string" && DOWNLOAD_VIDEO_QUALITY_SET.has(value);
}

export function readDownloadVideoQuality(settings: unknown): DownloadVideoQuality {
  if (!settings || typeof settings !== "object") return DEFAULT_DOWNLOAD_VIDEO_QUALITY;
  const quality = (settings as Record<string, unknown>).videoQuality;
  return isDownloadVideoQuality(quality) ? quality : DEFAULT_DOWNLOAD_VIDEO_QUALITY;
}

export function isBilibiliVideoQuality(value: unknown): value is BilibiliVideoQuality {
  return typeof value === "string" && BILIBILI_VIDEO_QUALITY_SET.has(value);
}

export function isBilibiliVideoCodec(value: unknown): value is BilibiliVideoCodec {
  return typeof value === "string" && BILIBILI_VIDEO_CODEC_SET.has(value);
}

export function isBilibiliAudioQuality(value: unknown): value is BilibiliAudioQuality {
  return typeof value === "string" && BILIBILI_AUDIO_QUALITY_SET.has(value);
}

export function isBilibiliStreamFormat(value: unknown): value is BilibiliStreamFormat {
  return typeof value === "string" && BILIBILI_STREAM_FORMAT_SET.has(value);
}

export function readBilibiliVideoQuality(settings: unknown): BilibiliVideoQuality {
  if (!settings || typeof settings !== "object") return DEFAULT_BILIBILI_VIDEO_QUALITY;
  const record = settings as Record<string, unknown>;
  return isBilibiliVideoQuality(record.bilibiliVideoQuality)
    ? record.bilibiliVideoQuality
    : readDownloadVideoQuality(settings);
}

export function readBilibiliVideoCodec(settings: unknown): BilibiliVideoCodec {
  if (!settings || typeof settings !== "object") return DEFAULT_BILIBILI_VIDEO_CODEC;
  const codec = (settings as Record<string, unknown>).bilibiliVideoCodec;
  return isBilibiliVideoCodec(codec) ? codec : DEFAULT_BILIBILI_VIDEO_CODEC;
}

export function readBilibiliAudioQuality(settings: unknown): BilibiliAudioQuality {
  if (!settings || typeof settings !== "object") return DEFAULT_BILIBILI_AUDIO_QUALITY;
  const quality = (settings as Record<string, unknown>).bilibiliAudioQuality;
  return isBilibiliAudioQuality(quality) ? quality : DEFAULT_BILIBILI_AUDIO_QUALITY;
}

export function readBilibiliStreamFormat(settings: unknown): BilibiliStreamFormat {
  if (!settings || typeof settings !== "object") return DEFAULT_BILIBILI_STREAM_FORMAT;
  const format = (settings as Record<string, unknown>).bilibiliStreamFormat;
  return isBilibiliStreamFormat(format) ? format : DEFAULT_BILIBILI_STREAM_FORMAT;
}

export type DownloadPathContext = {
  authorName?: string;
  caption?: string;
  contentType?: string;
  workId?: string;
};

export function buildDirectorySegments(
  organization: DownloadOrganization,
  context: DownloadPathContext,
  filename: string,
  now = new Date(),
): string[] {
  if (organization === "flat") return [];
  if (organization === "fileType") return [fileTypeDirectory(context.contentType, filename)];
  if (organization === "date") return [formatLocalDate(now)];
  if (organization === "author") return [sanitizeDownloadPathSegment(context.authorName, "未知作者")];
  return [sanitizeDownloadPathSegment(context.caption || context.workId, "未知作品")];
}

export function sanitizeDownloadPathSegment(value: string | undefined, fallback: string): string {
  const sanitized = value?.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/[. ]+$/g, "").slice(0, 100);
  return sanitized || fallback;
}

function fileTypeDirectory(contentType: string | undefined, filename: string): string {
  const type = contentType?.toLowerCase() ?? "";
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  if (type.startsWith("video/") || ["mp4", "mov", "mkv", "webm"].includes(extension)) return "视频";
  if (type.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "flac"].includes(extension)) return "音频";
  if (type.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif"].includes(extension)) return "图片";
  if (type.startsWith("text/") || ["txt", "md", "srt", "vtt", "json"].includes(extension)) return "文本";
  return "其他";
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
