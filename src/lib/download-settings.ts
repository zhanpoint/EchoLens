export const DOWNLOAD_ORGANIZATIONS = ["flat", "fileType", "date", "work", "author"] as const;

export type DownloadOrganization = (typeof DOWNLOAD_ORGANIZATIONS)[number];

export const DEFAULT_DOWNLOAD_ORGANIZATION: DownloadOrganization = "work";

const DOWNLOAD_ORGANIZATION_SET = new Set<string>(DOWNLOAD_ORGANIZATIONS);

export function isDownloadOrganization(value: unknown): value is DownloadOrganization {
  return typeof value === "string" && DOWNLOAD_ORGANIZATION_SET.has(value);
}

export type DownloadPathContext = {
  authorName?: string;
  contentType?: string;
  workId?: string;
  workTitle?: string;
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
  return [sanitizeDownloadPathSegment(context.workTitle || context.workId, "未知作品")];
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
