import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@/lib/bilibili/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/bilibili/client")>();
  return { ...original, requestBilibiliWbiJson: mocks.request };
});

import { collectBilibiliComments } from "@/lib/bilibili/comments";

describe("bilibili comments collector", () => {
  beforeEach(() => {
    mocks.request.mockReset();
  });

  it("collects all top-level pages and only the first reply page", async () => {
    const progress = vi.fn();
    mocks.request.mockImplementation(async (endpoint: string, params: Record<string, string | number>) => {
      if (endpoint.endsWith("/reply/reply")) {
        expect(params).toMatchObject({ oid: "42", pn: "1", ps: "20", root: "100", type: "1" });
        return {
          data: {
            replies: [{
              content: { message: "子评论" },
              ctime: 10,
              like: 2,
              member: { mid: "3", uname: "回复者" },
              rpid_str: "101",
            }],
          },
        };
      }
      const { offset } = JSON.parse(String(params.pagination_str)) as { offset: string };
      if (!offset) {
        return {
          data: {
            cursor: { is_end: false, pagination_reply: { next_offset: "next" } },
            replies: [
              {
                content: { message: "顶层评论" },
                count: 2,
                ctime: 9,
                like: 4,
                member: { mid: "1", uname: "作者" },
                rpid_str: "100",
              },
              { content: { message: "重复" }, member: {}, rpid_str: "same" },
            ],
          },
        };
      }
      return {
        data: {
          cursor: { is_end: true },
          replies: [
            { content: { message: "重复项" }, member: {}, rpid_str: "same" },
            { content: { message: "第二页" }, member: {}, rpid_str: "200" },
          ],
        },
      };
    });

    const result = await collectBilibiliComments({ aid: 42, cookie: "SESSDATA=test", onProgress: progress });

    expect(result.comments.map(({ id }) => id)).toEqual(["100", "same", "200"]);
    expect(result.comments[0]).toMatchObject({
      author: { id: "1", name: "作者" },
      likeCount: 4,
      publishedAt: 9_000,
      replies: [{ id: "101", text: "子评论" }],
      replyCount: 2,
      replyPageHasMore: true,
      text: "顶层评论",
    });
    expect(progress).toHaveBeenLastCalledWith({ commentCount: 3, page: 2 });
  });

  it("requires a valid aid and cookie before requesting upstream", async () => {
    await expect(collectBilibiliComments({ aid: 0, cookie: "test" })).rejects.toMatchObject({ code: "INVALID_AID" });
    await expect(collectBilibiliComments({ aid: 42, cookie: "" })).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
    expect(mocks.request).not.toHaveBeenCalled();
  });
});