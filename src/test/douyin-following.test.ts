import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDouyinFollowingUsers } from "@/lib/douyin/following";

afterEach(() => vi.restoreAllMocks());

describe("douyin following", () => {
  it("follows Douyin's time cursor and deduplicates users", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/aweme/v1/web/user/profile/self/") {
        return new Response(JSON.stringify({ user: { sec_uid: "self-sec" }, status_code: 0 }));
      }
      if (url.pathname === "/aweme/v1/web/user/following/list/") {
        expect(url.searchParams.get("sec_user_id")).toBe("self-sec");
        const maxTime = url.searchParams.get("max_time");
        if (!maxTime) {
          return new Response(JSON.stringify({
            followings: [
              { avatar_thumb: { url_list: ["https://example.com/user-1.jpg"] }, follower_status: 1, nickname: "用户一", sec_uid: "user-1", unique_id: "user_one" },
              { follower_status: 0, nickname: "用户二", sec_uid: "user-2", unique_id: "user_two" },
            ],
            has_more: 1,
            min_time: 100,
            status_code: 0,
          }));
        }
        expect(maxTime).toBe("100");
        return new Response(JSON.stringify({
          followings: [
            { nickname: "重复用户", sec_uid: "user-2" },
            { follower_status: 1, nickname: "用户三", sec_uid: "user-3", unique_id: "user_three" },
          ],
          has_more: 0,
          min_time: 0,
          status_code: 0,
        }));
      }
      return new Response("{}", { status: 404 });
    });

    await expect(collectDouyinFollowingUsers("sessionid=abc; ttwid=token")).resolves.toEqual([
      { avatarUrl: "https://example.com/user-1.jpg", followerCount: 0, id: "user-1", isMutual: true, name: "用户一", signature: "", uniqueId: "user_one", url: "https://www.douyin.com/user/user-1", workCount: 0 },
      { avatarUrl: "", followerCount: 0, id: "user-2", isMutual: false, name: "用户二", signature: "", uniqueId: "user_two", url: "https://www.douyin.com/user/user-2", workCount: 0 },
      { avatarUrl: "", followerCount: 0, id: "user-3", isMutual: true, name: "用户三", signature: "", uniqueId: "user_three", url: "https://www.douyin.com/user/user-3", workCount: 0 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
