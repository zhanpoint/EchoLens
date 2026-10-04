import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const picker = vi.hoisted(() => vi.fn());
vi.mock("@/lib/browser-download-directory", () => ({ chooseDownloadDirectory: picker }));
import { saveBatchFiles } from "@/lib/batch/browser-export";
import { buildExportRecord } from "@/lib/batch/export";

const record = (position: number) => buildExportRecord({ position, video: { id: `12345${position}`, title: "同名/标题", durationSeconds: 1, publishedAt: 0, coverUrl: "" }, transcript: `中文\n第 ${position + 1} 段` }, "douyin");
let files: Map<string, { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }>;
let getFile: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  files = new Map();
  getFile = vi.fn(async (name: string) => {
    const writable = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    files.set(name, writable);
    return { createWritable: async () => writable };
  });
  picker.mockResolvedValue({ getDirectoryHandle: vi.fn(async () => ({ getFileHandle: getFile })) });
});
afterEach(() => vi.unstubAllGlobals());

function mockStream(content: string) {
  const bytes = new TextEncoder().encode(content);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    // Split UTF-8 characters across network chunks; response.json handles decoding.
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }))));
}
describe("uncompressed batch files in a browser directory", () => {
  it("writes separate Markdown files from a single incremental UTF-8 response", async () => {
    mockStream(JSON.stringify({ videos: [record(0), record(1)] }));
    const progress = vi.fn();
    await saveBatchFiles("batch-1", "md", new AbortController().signal, progress);
    expect(fetch).toHaveBeenCalledOnce();
    expect([...files.keys()]).toEqual(["0001_同名_标题_123450.md", "0002_同名_标题_123451.md"]);
    expect(files.values().next().value!.write.mock.calls[0][0]).toContain("中文\n第 1 段");
    for (const writable of files.values()) expect(writable.close).toHaveBeenCalledOnce();
    expect(progress.mock.calls).toEqual([[1], [2]]);
  });
  it("stops before writing another file when canceled, retaining completed files", async () => {
    mockStream(JSON.stringify({ videos: [record(0), record(1)] }));
    const controller = new AbortController();
    await expect(saveBatchFiles("batch-1", "json", controller.signal, () => controller.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(getFile).toHaveBeenCalledOnce();
    expect(files.values().next().value!.close).toHaveBeenCalledOnce();
  });
  it("aborts an unfinished file write rather than committing a partial file", async () => {
    mockStream(JSON.stringify({ videos: [record(0)] }));
    const writable = { write: vi.fn(async () => { throw new Error("disk full"); }), close: vi.fn(), abort: vi.fn(async () => {}) };
    getFile.mockResolvedValue({ createWritable: async () => writable });
    await expect(saveBatchFiles("batch-1", "txt", new AbortController().signal, vi.fn())).rejects.toThrow("disk full");
    expect(writable.abort).toHaveBeenCalledOnce();
    expect(writable.close).not.toHaveBeenCalled();
  });
  it("continues from the last position with bounded JSON pages and a fixed snapshot", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ videos: Array.from({ length: 50 }, (_, i) => record(i)) }), { headers: { "x-export-as-of": "123" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ videos: [record(50)] }), { headers: { "x-export-as-of": "123" } }));
    vi.stubGlobal("fetch", fetch);
    await saveBatchFiles("batch-1", "txt", new AbortController().signal, vi.fn());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/batch/batch-1/export?format=json&after=-1", "/api/batch/batch-1/export?format=json&after=49&asOf=123"]);
    expect(getFile).toHaveBeenCalledTimes(51);
  });
});
