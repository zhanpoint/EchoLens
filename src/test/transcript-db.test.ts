import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertUser } from "@/lib/auth/db";
import {
  insertAsrTask,
  insertTranscriptHistorySummary,
  listTranscriptHistoryRecords,
  listTranscriptHistorySummaries,
  markAsrTaskFailed,
  markAsrTaskSucceeded,
  nextAsrQuotaResetAt,
  readAsrTask,
  readDailySucceededAsrDurationSeconds,
  readTranscriptHistoryRecord,
  deleteTranscriptHistoryRecord,
  deleteTranscriptHistorySummary,
  renameTranscriptHistoryRecord,
  updateTranscriptHistoryRecordTranscript,
  upsertTranscriptHistoryRecord,
} from "@/lib/transcript/db";
import { setupPostgresTestDb } from "@/test/postgres-test-utils";

setupPostgresTestDb();

describe("transcript db ASR quota and audio cache", () => {
  beforeEach(async () => {
    await insertUser({
      email: "reader@example.com",
      id: "user-1",
      passwordHash: "hash",
      termsAcceptedAt: Date.now(),
      username: "reader",
    });
    let now = new Date("2026-06-24T10:30:00+08:00").getTime();
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 1000;
      return now;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts only successful ASR task durations in the current local day", async () => {
    await insertAsrTask(taskInput({ id: "ok", seconds: 60 }));
    await insertAsrTask(taskInput({ id: "failed", seconds: 120 }));
    await markAsrTaskSucceeded("ok");
    await markAsrTaskFailed("failed", "failed");

    await expect(readDailySucceededAsrDurationSeconds({ userId: "user-1" })).resolves.toBe(60);

    vi.mocked(Date.now).mockReturnValue(new Date("2026-06-25T00:01:00+08:00").getTime());
    await expect(readDailySucceededAsrDurationSeconds({ userId: "user-1" })).resolves.toBe(0);
    expect(nextAsrQuotaResetAt()).toBe(new Date("2026-06-26T00:00:00+08:00").getTime());
  });

  it("persists ASR task history context for polling completion", async () => {
    await insertAsrTask(taskInput({
      historyContext: {
        historyRecordId: "history-a",
        work: {
          finalUrl: "https://www.douyin.com/video/100",
          id: "100",
          inputUrl: "https://v.douyin.com/100/",
          kind: "video",
          title: "作品 100",
        },
      },
      id: "job-a",
      seconds: 60,
    }));

    expect((await readAsrTask({ id: "job-a", userId: "user-1" }))?.historyContext).toEqual({
      historyRecordId: "history-a",
      work: {
        finalUrl: "https://www.douyin.com/video/100",
        id: "100",
        inputUrl: "https://v.douyin.com/100/",
        kind: "video",
        title: "作品 100",
      },
    });
  });

  it("updates the same transcript history session on retry", async () => {
    await upsertTranscriptHistoryRecord(historyInput({
      id: "history-a",
      transcriptContent: "第一次",
      workId: "100",
    }));
    await upsertTranscriptHistoryRecord(historyInput({
      id: "history-a",
      transcriptContent: "重试后的最新结果",
      workId: "100",
    }));

    await expect(listTranscriptHistoryRecords({ userId: "user-1" })).resolves.toHaveLength(1);
    await expect(readTranscriptHistoryRecord({ id: "history-a", userId: "user-1" })).resolves.toMatchObject({
      displayTitle: "作品 100",
      transcriptContent: "重试后的最新结果",
      workKey: "video:100",
    });
  });

  it("allows multiple history sessions for A-B-A work order", async () => {
    await upsertTranscriptHistoryRecord(historyInput({ id: "history-a1", workId: "100" }));
    await upsertTranscriptHistoryRecord(historyInput({ id: "history-b", workId: "200" }));
    await upsertTranscriptHistoryRecord(historyInput({ id: "history-a2", workId: "100" }));
    await upsertTranscriptHistoryRecord(historyInput({ id: "history-empty", transcriptContent: "", workId: "300" }));

    const records = await listTranscriptHistoryRecords({ userId: "user-1" });
    expect(records.map((record) => record.id)).toEqual(["history-a2", "history-b", "history-a1"]);
    expect(records.filter((record) => record.workKey === "video:100")).toHaveLength(2);
  });

  it("renames and physically deletes transcript history with summaries", async () => {
    await upsertTranscriptHistoryRecord(historyInput({ id: "history-a", workId: "100" }));
    await insertTranscriptHistorySummary({
      content: "总结一",
      historyRecordId: "history-a",
      id: "summary-1",
      promptId: "quick",
      promptTitle: "快速总结",
      userId: "user-1",
    });
    await insertTranscriptHistorySummary({
      content: "总结二",
      historyRecordId: "history-a",
      id: "summary-2",
      promptId: "deep",
      promptTitle: "深度总结",
      userId: "user-1",
    });

    await expect(renameTranscriptHistoryRecord({
      displayTitle: "自定义名称",
      id: "history-a",
      userId: "user-1",
    })).resolves.toMatchObject({ displayTitle: "自定义名称" });
    expect((await listTranscriptHistorySummaries({
      historyRecordId: "history-a",
      userId: "user-1",
    })).map((summary) => summary.id)).toEqual(["summary-2", "summary-1"]);

    await expect(deleteTranscriptHistoryRecord({ id: "history-a", userId: "user-1" })).resolves.toBe(true);
    await expect(readTranscriptHistoryRecord({ id: "history-a", userId: "user-1" })).resolves.toBeNull();
    await expect(listTranscriptHistorySummaries({ historyRecordId: "history-a", userId: "user-1" })).resolves.toEqual([]);
  });

  it("updates transcript content without dropping history summaries", async () => {
    await upsertTranscriptHistoryRecord(historyInput({ id: "history-a", workId: "100" }));
    await insertTranscriptHistorySummary({
      content: "已有总结",
      historyRecordId: "history-a",
      id: "summary-1",
      promptId: "quick",
      promptTitle: "快速总结",
      userId: "user-1",
    });

    const updated = await updateTranscriptHistoryRecordTranscript({
      id: "history-a",
      transcriptContent: "人工修订后的转录",
      transcriptSegments: [{ endSeconds: 2, startSeconds: 0, text: "人工修订后的转录" }],
      userId: "user-1",
    });

    expect(updated).toMatchObject({
      id: "history-a",
      transcriptContent: "人工修订后的转录",
      transcriptSegments: [{ endSeconds: 2, startSeconds: 0, text: "人工修订后的转录" }],
    });
    await expect(listTranscriptHistorySummaries({
      historyRecordId: "history-a",
      userId: "user-1",
    })).resolves.toMatchObject([{ content: "已有总结", id: "summary-1" }]);
  });

  it("deletes one transcript history summary without dropping sibling summaries", async () => {
    await upsertTranscriptHistoryRecord(historyInput({ id: "history-a", workId: "100" }));
    await insertTranscriptHistorySummary({
      content: "总结一",
      historyRecordId: "history-a",
      id: "summary-1",
      promptId: "quick",
      promptTitle: "快速总结",
      userId: "user-1",
    });
    await insertTranscriptHistorySummary({
      content: "总结二",
      historyRecordId: "history-a",
      id: "summary-2",
      promptId: "deep",
      promptTitle: "深度总结",
      userId: "user-1",
    });

    await expect(deleteTranscriptHistorySummary({
      historyRecordId: "history-a",
      id: "summary-1",
      userId: "user-1",
    })).resolves.toBe(true);
    await expect(listTranscriptHistorySummaries({
      historyRecordId: "history-a",
      userId: "user-1",
    })).resolves.toMatchObject([{ content: "总结二", id: "summary-2" }]);
    await expect(deleteTranscriptHistorySummary({
      historyRecordId: "history-a",
      id: "summary-1",
      userId: "user-1",
    })).resolves.toBe(false);
  });
});

function taskInput(input: {
  historyContext?: {
    historyRecordId: string;
    work: unknown;
  };
  id: string;
  seconds: number;
}) {
  return {
    audioDurationSeconds: input.seconds,
    cacheKey: `cache-${input.id}`,
    historyContext: input.historyContext,
    id: input.id,
    model: "qwen3-asr-flash-filetrans",
    objectKey: `object-${input.id}`,
    taskId: `task-${input.id}`,
    userId: "user-1",
    workKey: "video:1",
  };
}

function historyInput(input: {
  id: string;
  transcriptContent?: string;
  workId: string;
}) {
  return {
    authorName: "作者",
    durationSeconds: 60,
    finalUrl: `https://www.douyin.com/video/${input.workId}`,
    id: input.id,
    inputUrl: `https://v.douyin.com/${input.workId}/`,
    originalTitle: `作品 ${input.workId}`,
    transcriptContent: input.transcriptContent ?? `转录 ${input.workId}`,
    transcriptSegments: [{ endSeconds: 1, startSeconds: 0, text: input.transcriptContent ?? `转录 ${input.workId}` }],
    userId: "user-1",
    workId: input.workId,
    workKey: `video:${input.workId}`,
    workKind: "video",
  };
}
