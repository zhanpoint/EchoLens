import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/auth/_shared", () => ({
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));

const records = new Map<string, {
  sessionName: string;
  id: string;
  transcriptContent: string;
  transcriptSegments?: unknown;
}>();

vi.mock("@/lib/transcript/db", () => ({
  deleteTranscriptHistoryRecord: vi.fn(async ({ id }: { id: string }) => records.delete(id)),
  deleteTranscriptHistorySummary: vi.fn(async ({ id }: { id: string }) => id === "summary-1"),
  insertTranscriptHistorySummary: vi.fn(async (input) => ({
    content: input.content,
    createdAt: 1,
    id: input.id,
    promptId: input.promptId,
    promptTitle: input.promptTitle,
  })),
  listTranscriptHistoryRecords: vi.fn(async ({ query }: { query?: string }) =>
    [...records.values()].filter((record) =>
      record.transcriptContent && (!query || record.sessionName.includes(query))
    ),
  ),
  listTranscriptHistorySummaries: vi.fn(async () => [{ content: "总结", createdAt: 1, id: "summary-1", promptId: "p", promptTitle: "提示词" }]),
  readTranscriptHistoryRecord: vi.fn(async ({ id }: { id: string }) => records.get(id) ?? null),
  renameTranscriptHistoryRecord: vi.fn(async ({ sessionName, id }: { sessionName: string; id: string }) => {
    const record = records.get(id);
    if (!record) {
      return null;
    }
    const renamed = { ...record, sessionName };
    records.set(id, renamed);
    return renamed;
  }),
  updateTranscriptHistoryRecordTranscript: vi.fn(async ({
    id,
    transcriptContent,
    transcriptSegments,
  }: {
    id: string;
    transcriptContent: string;
    transcriptSegments?: unknown;
  }) => {
    const record = records.get(id);
    if (!record) {
      return null;
    }
    const updated = { ...record, transcriptContent, transcriptSegments };
    records.set(id, updated);
    return updated;
  }),
}));

import { requireUser } from "@/app/api/auth/_shared";
import { GET as GET_DETAIL, PATCH } from "@/app/api/transcript-history/[id]/route";
import { DELETE as DELETE_SUMMARY } from "@/app/api/transcript-history/[id]/summaries/route";
import { DELETE as DELETE_LIST, GET as GET_LIST } from "@/app/api/transcript-history/route";

const requireUserMock = vi.mocked(requireUser);

describe("transcript history routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    records.clear();
    records.set("history-1", { sessionName: "作品 A", id: "history-1", transcriptContent: "转录 A" });
    records.set("history-2", { sessionName: "作品 B", id: "history-2", transcriptContent: "转录 B" });
    requireUserMock.mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
  });

  it("lists and searches transcript history", async () => {
    const response = await GET_LIST(new Request("https://echolens.test/api/transcript-history?q=A"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      records: [{ sessionName: "作品 A", id: "history-1" }],
    });
  });

  it("deletes transcript history through the preloaded collection route", async () => {
    const response = await DELETE_LIST(new Request(
      "https://echolens.test/api/transcript-history?id=history-1",
      { method: "DELETE" },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(records.has("history-1")).toBe(false);
  });

  it("rejects collection deletes without a history ID", async () => {
    const response = await DELETE_LIST(new Request(
      "https://echolens.test/api/transcript-history",
      { method: "DELETE" },
    ));

    expect(response.status).toBe(400);
    expect(records.size).toBe(2);
  });

  it("reads transcript history details with summaries", async () => {
    const response = await GET_DETAIL(
      new Request("https://echolens.test/api/transcript-history/history-1"),
      routeContext("history-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      record: { id: "history-1" },
      summaries: [{ id: "summary-1" }],
    });
  });

  it("renames transcript history", async () => {
    const renameResponse = await PATCH(
      new Request("https://echolens.test/api/transcript-history/history-1", {
        body: JSON.stringify({ sessionName: "新名称" }),
        method: "PATCH",
      }),
      routeContext("history-1"),
    );
    expect(renameResponse.status).toBe(200);
    await expect(renameResponse.json()).resolves.toMatchObject({
      record: { sessionName: "新名称", id: "history-1" },
    });
  });

  it("deletes transcript history summaries", async () => {
    const response = await DELETE_SUMMARY(
      new Request("https://echolens.test/api/transcript-history/history-1/summaries?summaryId=summary-1", {
        method: "DELETE",
      }),
      routeContext("history-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });

    const missingResponse = await DELETE_SUMMARY(
      new Request("https://echolens.test/api/transcript-history/history-1/summaries?summaryId=missing", {
        method: "DELETE",
      }),
      routeContext("history-1"),
    );
    expect(missingResponse.status).toBe(404);
  });

  it("updates transcript content", async () => {
    const response = await PATCH(
      new Request("https://echolens.test/api/transcript-history/history-1", {
        body: JSON.stringify({
          transcriptContent: "人工修订后的转录。抖音。",
          transcriptSegments: [
            { endSeconds: 2, startSeconds: 0, text: "人工修订后的转录。" },
            { endSeconds: 3, startSeconds: 2, text: "抖音。" },
          ],
        }),
        method: "PATCH",
      }),
      routeContext("history-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      record: {
        id: "history-1",
        transcriptContent: "人工修订后的转录。抖音。",
        transcriptSegments: [
          { endSeconds: 2, startSeconds: 0, text: "人工修订后的转录。" },
          { endSeconds: 3, startSeconds: 2, text: "抖音。" },
        ],
      },
    });
  });

  it("requires authentication", async () => {
    requireUserMock.mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await GET_LIST(new Request("https://echolens.test/api/transcript-history"));

    expect(response.status).toBe(401);
  });
});

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}
