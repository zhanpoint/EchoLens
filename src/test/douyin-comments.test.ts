import { describe, expect, it, vi } from "vitest";
import { collectDouyinComments } from "@/lib/douyin/comments";
import type { DouyinWebClient } from "@/lib/douyin/web-client";

describe("douyin comments collector", () => {
  it("collects all top-level pages, deduplicates IDs, and prefetches the next page", async () => {
    const calls: string[] = [];
    const progress = vi.fn();
    const client = fakeClient(async (path, params) => {
      const cursor = Number(params.cursor);
      calls.push(path.includes("reply") ? `reply:${params.comment_id}` : `page:${cursor}`);
      if (path.includes("reply")) {
        return {
          comments: [{ cid: "r1", text: "回复", digg_count: 2, user: { nickname: "回复者" } }],
          cursor: 0,
          has_more: 1,
        };
      }
      if (cursor === 0) {
        return {
          comments: [
            { cid: "c1", text: "第一条", digg_count: 3, reply_comment_total: 2, user: { nickname: "甲" } },
            { cid: "same", text: "重复", user: { nickname: "乙" } },
          ],
          cursor: 20,
          has_more: 1,
        };
      }
      return {
        comments: [
          { cid: "same", text: "重复项", user: { nickname: "乙" } },
          { cid: "c2", text: "第二条", user: { nickname: "丙" } },
        ],
        cursor: 20,
        has_more: 0,
      };
    });

    const payload = await collectDouyinComments({ awemeId: "123", client, onProgress: progress });

    expect(payload.comments.map((comment) => comment.id)).toEqual(["c1", "same", "c2"]);
    expect(payload.comments[0]).toMatchObject({
      likeCount: 3,
      replies: [{ id: "r1", likeCount: 2, text: "回复" }],
      replyPageHasMore: true,
    });
    expect(calls.indexOf("page:20")).toBeLessThan(calls.indexOf("reply:c1"));
    expect(progress).toHaveBeenLastCalledWith({ commentCount: 3, page: 2 });
  });

  it("limits concurrent reply requests", async () => {
    let active = 0;
    let maxActive = 0;
    const client = fakeClient(async (path) => {
      if (!path.includes("reply")) {
        return {
          comments: Array.from({ length: 10 }, (_, index) => ({
            cid: `c${index}`,
            reply_comment_total: 1,
            text: `评论${index}`,
          })),
          has_more: 0,
        };
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { comments: [], has_more: 0 };
    });

    await collectDouyinComments({ awemeId: "123", client });

    expect(maxActive).toBe(4);
  });

  it("rejects the snapshot when a reply page cannot be collected", async () => {
    const client = fakeClient(async (path) => {
      if (path.includes("reply")) throw new Error("reply unavailable");
      return {
        comments: [{ cid: "c1", reply_comment_total: 1, text: "评论" }],
        has_more: 0,
      };
    });

    await expect(collectDouyinComments({ awemeId: "123", client }))
      .rejects.toThrow("reply unavailable");
  });

  it("stops when a cursor cannot advance", async () => {
    const request = vi.fn(async () => ({
      comments: [{ cid: "c1", text: "评论" }],
      cursor: 0,
      has_more: 1,
    }));
    await expect(collectDouyinComments({ awemeId: "123", client: fakeClient(request) }))
      .resolves.toMatchObject({ commentCount: 1 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function fakeClient(
  request: (path: string, params: Record<string, string | number>) => Promise<Record<string, unknown>>,
): DouyinWebClient {
  return {
    getSelfProfile: async () => ({}),
    query: () => ({ aid: "6383", msToken: "test-token" }),
    request,
  };
}