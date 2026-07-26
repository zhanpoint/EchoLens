import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  insertTranscriptHistorySummary: vi.fn(async (input) => ({
    content: input.content,
    createdAt: 1,
    id: input.id,
    promptId: input.promptId,
    promptTitle: input.promptTitle,
  })),
  readTranscriptHistoryRecord: vi.fn(async ({ id }: { id: string }) =>
    id === "history-1"
      ? { id, transcriptContent: "数据库中编辑后的转录" }
      : null
  ),
  streamSummarizeTranscript: vi.fn(async ({ transcript }: {
    onDelta?: (delta: string) => void;
    onReset?: () => void;
    signal?: AbortSignal;
    transcript: string;
  }) => ({
    content: `总结:${transcript}`,
    ok: true as const,
  })),
}));

vi.mock("@/app/api/auth/_shared", () => ({
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));

vi.mock("@/lib/dashscope/summary", () => ({
  streamSummarizeTranscript: mocks.streamSummarizeTranscript,
}));

vi.mock("@/lib/dashscope/user-credential", () => ({
  readDashScopeUserConfig: vi.fn(async () => ({
    apiKey: "test-user-key",
    models: { summary: "qwen3.7-plus" },
  })),
}));

vi.mock("@/lib/transcript/db", () => ({
  insertTranscriptHistorySummary: mocks.insertTranscriptHistorySummary,
  readTranscriptHistoryRecord: mocks.readTranscriptHistoryRecord,
}));

import { requireUser } from "@/app/api/auth/_shared";
import { POST } from "@/app/api/douyin/summarize/route";

const requireUserMock = vi.mocked(requireUser);

describe("summarize route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUserMock.mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
  });

  it("uses the latest persisted transcript when historyRecordId is provided", async () => {
    const response = await POST(new Request("https://echolens.test/api/douyin/summarize", {
      body: JSON.stringify({
        historyRecordId: "history-1",
        prompt: "总结",
        promptId: "quick",
        promptTitle: "快速总结",
        text: "前端旧转录",
      }),
      method: "POST",
    }));

    expect(response.status).toBe(200);
    expect(mocks.streamSummarizeTranscript).toHaveBeenCalledWith(expect.objectContaining({
      model: "qwen3.7-plus",
      transcript: "数据库中编辑后的转录",
    }));
    await expect(readSummaryEvents(response)).resolves.toContainEqual(expect.objectContaining({
      summary: expect.objectContaining({ content: "总结:数据库中编辑后的转录" }),
      type: "done",
      value: "总结:数据库中编辑后的转录",
    }));
  });

  it("emits replace before replacement deltas and persists only the final summary", async () => {
    mocks.streamSummarizeTranscript.mockImplementationOnce(async ({ onDelta, onReset }) => {
      onDelta?.("半截");
      onReset?.();
      onDelta?.("完整总结");
      return { content: "完整总结", ok: true as const };
    });
    const response = await POST(new Request("https://echolens.test/api/douyin/summarize", {
      body: JSON.stringify({
        historyRecordId: "history-1",
        prompt: "总结",
        promptId: "quick",
        promptTitle: "快速总结",
        text: "前端旧转录",
      }),
      method: "POST",
    }));

    await expect(readSummaryEvents(response)).resolves.toEqual([
      { type: "delta", value: "半截" },
      { type: "replace", value: "" },
      { type: "delta", value: "完整总结" },
      expect.objectContaining({ type: "done", value: "完整总结" }),
    ]);
    expect(mocks.insertTranscriptHistorySummary).toHaveBeenCalledTimes(1);
    expect(mocks.insertTranscriptHistorySummary).toHaveBeenCalledWith(expect.objectContaining({ content: "完整总结" }));
  });

  it("requires existing history records", async () => {
    const response = await POST(new Request("https://echolens.test/api/douyin/summarize", {
      body: JSON.stringify({
        historyRecordId: "missing",
        prompt: "总结",
        text: "前端转录",
      }),
      method: "POST",
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "转录历史不存在。" });
  });

  it("requires authentication", async () => {
    requireUserMock.mockResolvedValueOnce(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await POST(new Request("https://echolens.test/api/douyin/summarize", {
      body: JSON.stringify({ prompt: "总结", text: "前端转录" }),
      method: "POST",
    }));

    expect(response.status).toBe(401);
  });

  it("does not save partial summaries when the client aborts the stream", async () => {
    mocks.streamSummarizeTranscript.mockImplementationOnce(async ({ onDelta, signal }) => {
      onDelta?.("半截");
      await new Promise<void>((resolve) => {
        if (!signal) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        content: "不应保存",
        ok: true as const,
      };
    });
    const controller = new AbortController();
    const response = await POST(new Request("https://echolens.test/api/douyin/summarize", {
      body: JSON.stringify({
        historyRecordId: "history-1",
        prompt: "总结",
        promptId: "quick",
        promptTitle: "快速总结",
        text: "前端转录",
      }),
      method: "POST",
      signal: controller.signal,
    }));

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader!.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain("半截");

    controller.abort();
    await expect(reader!.read()).resolves.toMatchObject({ done: true });
    expect(mocks.insertTranscriptHistorySummary).not.toHaveBeenCalled();
  });

  it("aborts the upstream request when the response body is canceled", async () => {
    let upstreamSignal: AbortSignal | undefined;
    mocks.streamSummarizeTranscript.mockImplementationOnce(async ({ onDelta, signal }) => {
      upstreamSignal = signal;
      onDelta?.("已生成内容");
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { content: "不应保存", ok: true as const };
    });
    const response = await POST(new Request("https://echolens.test/api/douyin/summarize", {
      body: JSON.stringify({
        historyRecordId: "history-1",
        prompt: "总结",
        promptId: "quick",
        promptTitle: "快速总结",
        text: "前端转录",
      }),
      method: "POST",
    }));
    const reader = response.body!.getReader();

    const firstChunk = await reader.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain("已生成内容");
    await reader.cancel();
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));

    expect(mocks.insertTranscriptHistorySummary).not.toHaveBeenCalled();
  });
});

async function readSummaryEvents(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => JSON.parse(chunk.replace(/^data:\s*/u, "")) as unknown);
}
