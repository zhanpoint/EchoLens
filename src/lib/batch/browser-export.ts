import { chooseDownloadDirectory } from "@/lib/browser-download-directory";
import type { ExportFormat } from "./contracts";
import { exportFilename, serializeExportRecord, type TranscriptExportRecord } from "./export";

export async function saveBatchFiles(
  batchId: string,
  format: ExportFormat,
  signal: AbortSignal,
  onProgress: (count: number) => void,
): Promise<void> {
  // The picker runs directly from the click, before awaiting network work.
  const root = await chooseDownloadDirectory();
  signal.throwIfAborted();
  const directory = await root.getDirectoryHandle(`echolens-${batchId}`, { create: true });
  let count = 0;
  let after = -1;
  let asOf: string | null = null;
  for (;;) {
    signal.throwIfAborted();
    const query = new URLSearchParams({ format: "json", after: String(after) });
    if (asOf) query.set("asOf", asOf);
    const response = await fetch(`/api/batch/${batchId}/export?${query}`, { signal, cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "导出失败，请稍后重试。");
    asOf = response.headers.get("x-export-as-of");
    const records = payload.videos as TranscriptExportRecord[];
    for (const record of records) {
      signal.throwIfAborted();
      const file = await directory.getFileHandle(exportFilename(record, format), { create: true });
      const writable = await file.createWritable();
      try {
        await writable.write(serializeExportRecord(record, format));
        signal.throwIfAborted();
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      after = record.position;
      onProgress(++count);
    }
    if (records.length < 50) return;
  }
}
