import { beforeEach, describe, expect, it } from "vitest";
import { insertUser } from "@/lib/auth/db";
import type { DouyinCommentsPayload } from "@/lib/douyin/comments";
import {
  readTranscriptHistoryComments,
  readTranscriptHistoryCommentsMetadata,
  upsertTranscriptHistoryComments,
} from "@/lib/transcript/comments";
import {
  deleteTranscriptHistoryRecord,
  upsertTranscriptHistoryRecord,
} from "@/lib/transcript/db";
import { setupPostgresTestDb } from "@/test/postgres-test-utils";

setupPostgresTestDb();

describe("transcript comments persistence", () => {
  beforeEach(async () => {
    await insertUser({
      email: "reader@example.com",
      id: "user-1",
      passwordHash: "hash",
      termsAcceptedAt: Date.now(),
      username: "reader",
    });
    await insertUser({
      email: "other@example.com",
      id: "user-2",
      passwordHash: "hash",
      termsAcceptedAt: Date.now(),
      username: "other",
    });
    await upsertTranscriptHistoryRecord({
      caption: "作品",
      finalUrl: "https://www.douyin.com/video/123",
      id: "history-1",
      inputUrl: "https://v.douyin.com/test/",
      transcriptContent: "",
      userId: "user-1",
      workId: "123",
      workKey: "video:123",
      workKind: "video",
    });
  });

  it("overwrites the complete JSON payload", async () => {
    await expect(upsertTranscriptHistoryComments({
      historyRecordId: "history-1",
      payload: payload("old", 1),
      userId: "user-1",
    })).resolves.toBe(true);
    await expect(upsertTranscriptHistoryComments({
      historyRecordId: "history-1",
      payload: payload("new", 2),
      userId: "user-1",
    })).resolves.toBe(true);

    await expect(readTranscriptHistoryComments({ historyRecordId: "history-1", userId: "user-1" }))
      .resolves.toEqual(payload("new", 2));
    await expect(readTranscriptHistoryCommentsMetadata({ historyRecordId: "history-1", userId: "user-1" }))
      .resolves.toEqual({ collectedAt: 2, commentCount: 1 });
  });

  it("isolates comments by owner and cascades history deletion", async () => {
    await upsertTranscriptHistoryComments({
      historyRecordId: "history-1",
      payload: payload("comment", 1),
      userId: "user-1",
    });

    await expect(readTranscriptHistoryComments({ historyRecordId: "history-1", userId: "user-2" }))
      .resolves.toBeNull();
    await expect(upsertTranscriptHistoryComments({
      historyRecordId: "history-1",
      payload: payload("forbidden", 2),
      userId: "user-2",
    })).resolves.toBe(false);

    await deleteTranscriptHistoryRecord({ id: "history-1", userId: "user-1" });
    await expect(readTranscriptHistoryComments({ historyRecordId: "history-1", userId: "user-1" }))
      .resolves.toBeNull();
  });
});

function payload(text: string, collectedAt: number): DouyinCommentsPayload {
  return {
    awemeId: "123",
    collectedAt,
    commentCount: 1,
    comments: [{
      author: { id: "author", name: "作者" },
      id: "comment",
      likeCount: 3,
      publishedAt: 1,
      text,
    }],
  };
}
