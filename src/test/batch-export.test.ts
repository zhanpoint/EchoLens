import { describe, expect, it } from "vitest";
import { buildExportRecord, exportFilename, exportTranscripts, serializeExportRecord } from "@/lib/batch/export";
import type { ExportFormat } from "@/lib/batch/contracts";

const rows = [
  {
    position: 0,
    video: {
      id: "123456",
      title: "同名/标题",
      coverUrl: "",
      durationSeconds: 1,
      publishedAt: 0,
    },
    transcript: "第一段文字",
  },
  {
    position: 1,
    video: {
      id: "123457",
      title: "同名/标题",
      coverUrl: "",
      durationSeconds: 1,
      publishedAt: 0,
    },
    transcript: "第二段文字",
  },
];
async function* records() {
  yield* rows;
}
async function collect(format: ExportFormat) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of exportTranscripts(records(), "douyin", format))
    chunks.push(chunk);
  return Buffer.concat(chunks);
}
describe("batch transcript export", () => {
  it("creates distinct plain-text filenames for same-title videos", () => {
    expect(rows.map((row) => exportFilename(buildExportRecord(row, "douyin"), "md"))).toEqual(["0001_同名_标题_123456.md", "0002_同名_标题_123457.md"]);
  });
  it.each(["md", "txt"] as const)("merges %s in selection order with metadata and original transcripts", async (format) => {
    const text = (await collect(format)).toString("utf8");
    expect(text.indexOf("第一段文字")).toBeLessThan(text.indexOf("第二段文字"));
    expect(text).toContain("同名/标题");
    expect(text).toContain("https://www.douyin.com/video/123457");
    expect(text).toContain("发布时间：未知");
  });
  it("produces valid JSON with lossless multiline transcripts", async () => {
    const format = "json";
    const content = (await collect(format)).toString("utf8");
    const result = JSON.parse(content).videos;
    expect(result.map((row: { transcript: string }) => row.transcript)).toEqual(["第一段文字", "第二段文字"]);
    expect(result[0]).toMatchObject({ id: "123456", platform: "douyin", publishedAt: null });
    const original = buildExportRecord({ ...rows[0], transcript: '正文\n"引用"\\路径\n# Markdown' }, "douyin");
    expect(JSON.parse(serializeExportRecord(original, format))).toEqual(original);
  });
  it("streams a valid empty JSON document without loading all rows", async () => {
    async function* empty() { /* No completed rows. */ }
    const chunks: Uint8Array[] = [];
    for await (const chunk of exportTranscripts(empty(), "douyin", "json")) chunks.push(chunk);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ schemaVersion: 1, videos: [] });
  });
});
