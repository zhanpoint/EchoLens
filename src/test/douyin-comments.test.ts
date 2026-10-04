import { describe, expect, it, vi } from "vitest";
import { collectDouyinComments } from "@/lib/douyin/comments";
import type { DouyinWebClient } from "@/lib/douyin/web-client";

describe("douyin comments collector", () => {
  it("collects all top-level pages and deduplicates IDs without speculative requests", async () => {
    const calls: string[] = [];
    const progress = vi.fn();
    const client = fakeClient(async (path, params) => {
      expect(path).toBe("/aweme/v1/web/comment/list/");
      const cursor = Number(params.cursor);
      calls.push(`page:${cursor}`);
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
    expect(payload.comments[0]).toEqual({
      author: { id: "", name: "甲" },
      id: "c1",
      likeCount: 3,
      publishedAt: 0,
      text: "第一条",
    });
    expect(calls).toEqual(["page:0", "page:20"]);
    expect(progress).toHaveBeenLastCalledWith({ commentCount: 3, page: 2 });
  });

  it("returns an empty snapshot when there are no visible comments", async () => {
    const request = vi.fn(async () => ({ comments: [], has_more: 0 }));
    await expect(collectDouyinComments({ awemeId: "123", client: fakeClient(request) }))
      .resolves.toMatchObject({ commentCount: 0, comments: [] });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects an incomplete snapshot when a later comment page fails", async () => {
    const request = vi.fn(async (_path, params: Record<string, string | number>) => {
      if (params.cursor === 20) throw new Error("page unavailable");
      return {
        comments: [{ cid: "c1", text: "评论" }],
        cursor: 20,
        has_more: 1,
      };
    });

    await expect(collectDouyinComments({ awemeId: "123", client: fakeClient(request) }))
      .rejects.toThrow("page unavailable");
    expect(request).toHaveBeenCalledTimes(2);
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
    query: () => ({ aid: "6383" }),
    request,
    verifyAuthenticatedSession: async () => undefined,
  };
}
