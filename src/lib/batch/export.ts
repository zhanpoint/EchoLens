import { sanitizeDownloadPathSegment } from "@/lib/download-settings";
import { videoUrl, type BatchExportRow, type BatchPlatform, type ExportFormat } from "./contracts";

export type TranscriptExportRecord = {
  position: number;
  platform: BatchPlatform;
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  durationSeconds: number;
  tags: string[];
  transcript: string;
};

export function buildExportRecord(row: BatchExportRow, platform: BatchPlatform): TranscriptExportRecord {
  return {
    position: row.position,
    platform,
    id: row.video.id,
    title: row.video.title,
    url: videoUrl(platform, row.video.id),
    publishedAt: row.video.publishedAt > 0 ? new Date(row.video.publishedAt).toISOString() : null,
    durationSeconds: row.video.durationSeconds,
    tags: row.video.tags ?? [],
    transcript: row.transcript,
  };
}

export function exportFilename(record: Pick<TranscriptExportRecord, "position" | "title" | "id">, format: ExportFormat): string {
  return `${String(record.position + 1).padStart(4, "0")}_${sanitizeDownloadPathSegment(record.title, record.id)}_${record.id}.${format}`;
}

export function serializeExportRecord(record: TranscriptExportRecord, format: ExportFormat): string {
  if (format === "json") return JSON.stringify(record, null, 2);
  const title = record.title.replace(/[\r\n]+/gu, " ");
  const metadata = [
    `平台：${record.platform === "douyin" ? "抖音" : "哔哩哔哩"}`,
    `作品 ID：${record.id}`,
    `来源：${record.url}`,
    `发布时间：${record.publishedAt ?? "未知"}`,
    `时长：${record.durationSeconds} 秒`,
    ...(record.tags.length ? [`标签：${record.tags.map((tag) => `#${tag}`).join(" ")}`] : []),
  ];
  return format === "md"
    ? `## ${record.position + 1}. ${title.replace(/[\\`*_{}\[\]<>#!|]/gu, "\\$&")}\n\n${metadata.map((line) => `- ${line}`).join("\n")}\n\n### 转录正文\n\n${record.transcript}\n\n---\n\n`
    : `${record.position + 1}. ${title}\n${metadata.join("\n")}\n\n${record.transcript}\n\n${"─".repeat(40)}\n\n`;
}

export async function* exportTranscripts(
  rows: AsyncIterable<BatchExportRow>,
  platform: BatchPlatform,
  format: ExportFormat,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  if (format === "json") yield encoder.encode('{"schemaVersion":1,"videos":[\n');
  if (format === "md") yield encoder.encode("# 博主语料采集\n\n");
  let first = true;
  for await (const row of rows) {
    const content = serializeExportRecord(buildExportRecord(row, platform), format);
    yield encoder.encode(`${format === "json" && !first ? ",\n" : ""}${content}`);
    first = false;
  }
  if (format === "json") yield encoder.encode("\n]}\n");
}
