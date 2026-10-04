import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), read: vi.fn(), rows: vi.fn() }));
vi.mock("@/app/api/auth/_shared", () => ({ requireUser: mocks.user }));
vi.mock("@/lib/batch/db", () => ({ readBatch: mocks.read, readBatchExport: mocks.rows }));
import { GET } from "@/app/api/batch/[id]/export/route";

const row = { position: 0, video: { id: "123456", title: "视频", coverUrl: "", durationSeconds: 1, publishedAt: 0 }, transcript: "正文" };
const context = { params: Promise.resolve({ id: "batch-1" }) };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "owner" });
  mocks.read.mockResolvedValue({ job: { succeeded: 1, platform: "douyin" }, items: [{ ...row, status: "succeeded" }] });
  mocks.rows.mockImplementation(async function* () { yield row; });
});

describe("batch export route", () => {
  it.each([undefined, "md", "txt", "json"])("downloads an uncompressed %s file", async (format) => {
    const response = await GET(new Request(`https://echolens.test/export${format ? `?format=${format}` : ""}`), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(`.${format ?? "md"}`);
    expect(response.headers.get("content-type")).not.toContain("zip");
    const content = await response.text();
    expect(content).toContain("正文");
    if (format === "json") expect(JSON.parse(content).videos).toHaveLength(1);
  });
  it("restricts a single-video download to its completed position", async () => {
    const response = await GET(new Request("https://echolens.test/export?format=md&position=0"), context);
    expect(response.status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith("owner", "batch-1", 0);
    expect(mocks.rows).toHaveBeenCalledWith("owner", "batch-1", expect.objectContaining({ asOf: expect.any(Number), position: 0 }));
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    await response.text();
  });
  it("reads bounded JSON pages using the same export snapshot", async () => {
    const response = await GET(new Request("https://echolens.test/export?format=json&after=0&asOf=123"), context);
    expect(response.headers.get("x-export-as-of")).toBe("123");
    expect(mocks.rows).toHaveBeenCalledWith("owner", "batch-1", { asOf: 123, position: undefined, after: 0, limit: 50 });
    await response.text();
  });
  it("rejects invalid formats, missing or unfinished positions and unauthorized batches", async () => {
    expect((await GET(new Request("https://echolens.test/export?format=zip"), context)).status).toBe(400);
    expect((await GET(new Request("https://echolens.test/export?format=jsonl"), context)).status).toBe(400);
    expect((await GET(new Request("https://echolens.test/export?position=-1"), context)).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
    expect((await GET(new Request("https://echolens.test/export?position=1"), context)).status).toBe(404);
    mocks.read.mockResolvedValueOnce({ job: { succeeded: 1, platform: "douyin" }, items: [{ ...row, status: "queued" }] });
    expect((await GET(new Request("https://echolens.test/export?position=0"), context)).status).toBe(409);
    mocks.read.mockResolvedValueOnce(null);
    expect((await GET(new Request("https://echolens.test/export"), context)).status).toBe(404);
    expect(mocks.rows).not.toHaveBeenCalled();
  });
});
