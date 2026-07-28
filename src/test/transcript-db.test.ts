import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertUser } from "@/lib/auth/db";
import {
  insertAsrTask,
  insertTranscriptHistorySummary,
  listTranscriptHistoryRecords,
  listTranscriptHistorySummaries,
  markAsrTaskFailed,
  markAsrTaskSucceeded,
  readAsrTask,
  readPlatformAsrQuotaUsageSeconds,
  readTranscriptHistorySummary,
  reserveAsrTask,
  readTranscriptHistoryRecord,
  deleteTranscriptHistoryRecord,
  deleteTranscriptHistorySummary,
  deleteAsrTask,
  findOrCreateTranscriptHistoryRecord,
  markAsrTaskCanceled,
  renameTranscriptHistoryRecord,
  updateTranscriptHistoryRecordMetadata,
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

  it("counts running and successful platform ASR duration across all time", async () => {
    await insertAsrTask(taskInput({ id: "ok", seconds: 60 }));
    await insertAsrTask(taskInput({ id: "failed", seconds: 120 }));
    await insertAsrTask(taskInput({ id: "running", seconds: 30 }));
    await insertAsrTask(taskInput({ credentialSource: "custom", id: "custom", seconds: 180 }));
    await markAsrTaskSucceeded("ok");
    await markAsrTaskSucceeded("custom");
    await markAsrTaskFailed("failed", "failed");

    await expect(readPlatformAsrQuotaUsageSeconds({ userId: "user-1" })).resolves.toBe(90);

    await markAsrTaskFailed("running", "failed");
    await expect(readPlatformAsrQuotaUsageSeconds({ userId: "user-1" })).resolves.toBe(60);

    vi.mocked(Date.now).mockReturnValue(new Date("2026-06-25T00:01:00+08:00").getTime());
    await expect(readPlatformAsrQuotaUsageSeconds({ userId: "user-1" })).resolves.toBe(60);
  });

  it("atomically refuses a platform reservation that would exceed the lifetime limit", async () => {
    await insertAsrTask(taskInput({ id: "used", seconds: 3_550 }));
    await markAsrTaskSucceeded("used");

    await expect(reserveAsrTask({
      audioDurationSeconds: 60,
      cacheKey: "cache-next",
      credentialSource: "platform",
      id: "next",
      model: "qwen3-asr-flash-filetrans",
      objectKey: "object-next",
      userId: "user-1",
      workKey: "video:1",
    }, 3_600)).resolves.toBe(false);
    await expect(readAsrTask({ id: "next", userId: "user-1" })).resolves.toBeNull();
  });

  it("deletes canceled ASR task records", async () => {
    await insertAsrTask(taskInput({ id: "canceled", seconds: 60 }));
    await markAsrTaskCanceled("canceled");

    await expect(deleteAsrTask({ id: "canceled", userId: "user-1" })).resolves.toBe(true);
    await expect(readAsrTask({ id: "canceled", userId: "user-1" })).resolves.toBeNull();
  });

  it("persists ASR task history context for polling completion", async () => {
    await insertAsrTask(taskInput({
      historyContext: {
        historyRecordId: "history-a",
        work: {
          finalUrl: "https://www.douyin.com/video/7649250336875613449",
          id: "7649250336875613449",
          inputUrl: "https://v.douyin.com/test/",
          kind: "video",
          caption: "作品 100",
        },
      },
      id: "job-a",
      seconds: 60,
    }));

    expect((await readAsrTask({ id: "job-a", userId: "user-1" }))?.historyContext).toEqual({
      historyRecordId: "history-a",
      work: {
        finalUrl: "https://www.douyin.com/video/7649250336875613449",
        id: "7649250336875613449",
        inputUrl: "https://v.douyin.com/test/",
        kind: "video",
        caption: "作品 100",
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
      sessionName: "作品 100",
      transcriptContent: "重试后的最新结果",
      workKey: "video:100",
    });
  });

  it("keeps the work title independent from the editable session name", async () => {
    await findOrCreateTranscriptHistoryRecord(
      historyInput({ id: "history-caption", workId: "caption" }),
    );
    await renameTranscriptHistoryRecord({
      sessionName: "我的会话",
      id: "history-caption",
      userId: "user-1",
    });

    await updateTranscriptHistoryRecordMetadata({
      caption: "更新后的作品标题",
      historyRecordId: "history-caption",
      userId: "user-1",
    });
    await expect(readTranscriptHistoryRecord({ id: "history-caption", userId: "user-1" })).resolves.toMatchObject({
      caption: "更新后的作品标题",
      sessionName: "我的会话",
    });
  });

  it("rejects history records without a work title", async () => {
    await expect(findOrCreateTranscriptHistoryRecord({
      ...historyInput({ id: "history-empty-caption", workId: "empty-caption" }),
      caption: " ",
    })).rejects.toThrow("作品标题不能为空。");
  });

  it("finds the existing user session by stable work key when the final URL changes", async () => {
    const first = await findOrCreateTranscriptHistoryRecord({
      ...historyInput({ id: "history-old", workId: "100" }),
      finalUrl: "https://www.douyin.com/video/100?share=old",
    });
    const second = await findOrCreateTranscriptHistoryRecord({
      ...historyInput({ id: "history-new", workId: "100" }),
      finalUrl: "https://www.douyin.com/video/100?share=new",
    });

    expect(first).toMatchObject({ created: true, record: { id: "history-old" } });
    expect(second).toMatchObject({ created: false, record: { id: "history-old" } });
    await expect(listTranscriptHistoryRecords({ userId: "user-1" })).resolves.toHaveLength(1);
  });

  it("atomically converges concurrent detections onto one session", async () => {
    const results = await Promise.all([
      findOrCreateTranscriptHistoryRecord(historyInput({ id: "history-a", workId: "concurrent" })),
      findOrCreateTranscriptHistoryRecord(historyInput({ id: "history-b", workId: "concurrent" })),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.record.id)).size).toBe(1);
    await expect(listTranscriptHistoryRecords({ userId: "user-1" })).resolves.toHaveLength(1);
  });

  it("cannot overwrite another user's history through a colliding id", async () => {
    await insertUser({
      email: "other@example.com",
      id: "user-2",
      passwordHash: "hash",
      termsAcceptedAt: Date.now(),
      username: "other-user",
    });
    await upsertTranscriptHistoryRecord(historyInput({ id: "shared-id", transcriptContent: "owner content", workId: "100" }));

    await expect(upsertTranscriptHistoryRecord({
      ...historyInput({ id: "shared-id", transcriptContent: "attacker content", workId: "100" }),
      userId: "user-2",
    })).rejects.toThrow("转录历史保存失败。");
    await expect(readTranscriptHistoryRecord({ id: "shared-id", userId: "user-1" })).resolves.toMatchObject({
      transcriptContent: "owner content",
    });
    await expect(readTranscriptHistoryRecord({ id: "shared-id", userId: "user-2" })).resolves.toBeNull();
  });

  it("isolates the same work identity between users", async () => {
    await insertUser({
      email: "other-work@example.com",
      id: "user-2",
      passwordHash: "hash",
      termsAcceptedAt: Date.now(),
      username: "other-work-user",
    });
    const ownerSession = await findOrCreateTranscriptHistoryRecord(
      historyInput({ id: "history-owner", workId: "100" }),
    );
    const otherSession = await findOrCreateTranscriptHistoryRecord({
      ...historyInput({ id: "history-other", workId: "100" }),
      userId: "user-2",
    });

    expect(ownerSession).toMatchObject({ created: true, record: { id: "history-owner", userId: "user-1" } });
    expect(otherSession).toMatchObject({ created: true, record: { id: "history-other", userId: "user-2" } });
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
      sessionName: "自定义名称",
      id: "history-a",
      userId: "user-1",
    })).resolves.toMatchObject({ sessionName: "自定义名称" });
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

  it("prevents cross-user summary access through history ownership", async () => {
    await insertUser({
      email: "other-summary@example.com",
      id: "user-2",
      passwordHash: "hash",
      termsAcceptedAt: Date.now(),
      username: "other-summary-user",
    });
    await upsertTranscriptHistoryRecord(historyInput({ id: "history-a", workId: "100" }));
    await insertTranscriptHistorySummary({
      content: "仅所有者可见",
      historyRecordId: "history-a",
      id: "summary-1",
      promptId: "quick",
      promptTitle: "快速总结",
      userId: "user-1",
    });

    await expect(insertTranscriptHistorySummary({
      content: "越权写入",
      historyRecordId: "history-a",
      id: "summary-2",
      promptId: "quick",
      promptTitle: "快速总结",
      userId: "user-2",
    })).rejects.toThrow("转录总结保存失败。");
    await expect(listTranscriptHistorySummaries({
      historyRecordId: "history-a",
      userId: "user-2",
    })).resolves.toEqual([]);
    await expect(readTranscriptHistorySummary({
      historyRecordId: "history-a",
      id: "summary-1",
      userId: "user-2",
    })).resolves.toBeNull();
    await expect(deleteTranscriptHistorySummary({
      historyRecordId: "history-a",
      id: "summary-1",
      userId: "user-2",
    })).resolves.toBe(false);
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
  credentialSource?: "custom" | "platform";
  historyContext?: {
    historyRecordId: string;
    work: {
      authorName?: string;
      authorUrl?: string;
      caption: string;
      durationSeconds?: number;
      finalUrl: string;
      id: string;
      inputUrl: string;
      kind: "video";
    };
  };
  id: string;
  seconds: number;
}) {
  return {
    audioDurationSeconds: input.seconds,
    cacheKey: `cache-${input.id}`,
    credentialSource: input.credentialSource,
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
    caption: `作品 ${input.workId}`,
    durationSeconds: 60,
    finalUrl: `https://www.douyin.com/video/${input.workId}`,
    id: input.id,
    inputUrl: `https://v.douyin.com/${input.workId}/`,
    transcriptContent: input.transcriptContent ?? `转录 ${input.workId}`,
    transcriptSegments: [{ endSeconds: 1, startSeconds: 0, text: input.transcriptContent ?? `转录 ${input.workId}` }],
    userId: "user-1",
    workId: input.workId,
    workKey: `video:${input.workId}`,
    workKind: "video",
  };
}
