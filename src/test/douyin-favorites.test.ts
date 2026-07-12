import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectDouyinFavorites,
  DouyinApiError,
  normalizeCookie,
} from "@/lib/douyin/favorites";
import { validateDouyinCredential } from "@/lib/douyin/account";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("douyin favorites", () => {
  it("normalizes cookie spacing", () => {
    expect(normalizeCookie(" sessionid=abc ; ; msToken=token ")).toBe("sessionid=abc; msToken=token");
  });

  it("expands collect folders, deduplicates aweme, and returns display fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const headers = init?.headers as Record<string, string>;
      expect(headers.cookie).toBe("sessionid=abc; msToken=token");
      expect(url.searchParams.get("X-Bogus")).toBeTruthy();

      if (url.pathname === "/aweme/v1/web/user/profile/self/") {
        return new Response(JSON.stringify({
          status_code: 0,
          user: { sec_uid: "self-sec" },
        }));
      }

      if (url.pathname === "/aweme/v1/web/aweme/favorite/") {
        return new Response(JSON.stringify({
          aweme_list: [],
          has_more: 0,
          max_cursor: 0,
          status_code: 0,
        }));
      }

      if (url.pathname === "/aweme/v1/web/collects/list/") {
        return new Response(JSON.stringify({
          collects_list: [
            { collects_id_str: "folder-1" },
            { collects_info: { collects_id: "folder-2" } },
          ],
          cursor: 0,
          has_more: 0,
        }));
      }

      if (url.pathname === "/aweme/v1/web/collects/video/list/" && url.searchParams.get("collects_id") === "folder-1") {
        return new Response(JSON.stringify({
          aweme_list: [
            {
              author: {
                avatar_thumb: { url_list: ["https://example.com/author-1.jpg"] },
                follow_status: 1,
                nickname: "作者一",
                sec_uid: "author-1",
              },
              aweme_id: "7649250336875613449",
              create_time: 1_700_000_000,
              desc: "第一条视频",
            },
          ],
          cursor: 0,
          has_more: 0,
        }));
      }

      if (url.pathname === "/aweme/v1/web/collects/video/list/" && url.searchParams.get("collects_id") === "folder-2") {
        return new Response(JSON.stringify({
          aweme_list: [
            {
              aweme_info: {
                author: { nickname: "作者一" },
                aweme_id: "7649250336875613449",
                desc: "重复视频",
              },
            },
            {
              author: { follow_status: 0, nickname: "作者二", sec_uid: "author-2" },
              aweme_id: "7649250336875613450",
              caption: "第二条视频",
              create_time: 1_700_000_100,
            },
          ],
          cursor: 0,
          has_more: 0,
        }));
      }

      return new Response("{}", { status: 404 });
    });

    await expect(
      collectDouyinFavorites({ cookie: "sessionid=abc; msToken=token" }),
    ).resolves.toEqual({
      authors: [
        { avatarUrl: "https://example.com/author-1.jpg", id: "author-1", name: "作者一" },
        { avatarUrl: "", id: "author-2", name: "作者二" },
      ],
      videos: [{
        author: "作者一",
        authorId: "author-1",
        isFollowing: true,
        publishedAt: 1_700_000_000,
        title: "第一条视频",
        url: "https://www.douyin.com/video/7649250336875613449",
      },
      {
        author: "作者二",
        authorId: "author-2",
        isFollowing: false,
        publishedAt: 1_700_000_100,
        title: "第二条视频",
        url: "https://www.douyin.com/video/7649250336875613450",
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("reads the logged-in account favorite stream even when collect folders are empty", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));

      if (url.pathname === "/aweme/v1/web/user/profile/self/") {
        return new Response(JSON.stringify({
          status_code: 0,
          user: { sec_uid: "self-sec" },
        }));
      }

      if (url.pathname === "/aweme/v1/web/aweme/favorite/") {
        expect(url.searchParams.get("sec_user_id")).toBe("self-sec");
        return new Response(JSON.stringify({
          aweme_list: [
            {
              author: { nickname: "默认作者" },
              aweme_id: "7649250336875613451",
              create_time: 1_700_000_200,
              desc: "默认收藏视频",
            },
          ],
          has_more: 0,
          max_cursor: 0,
          status_code: 0,
        }));
      }

      if (url.pathname === "/aweme/v1/web/collects/list/") {
        return new Response(JSON.stringify({
          collects_list: [],
          cursor: 0,
          has_more: 0,
          status_code: 0,
        }));
      }

      return new Response("{}", { status: 404 });
    });

    await expect(
      collectDouyinFavorites({ cookie: "sessionid=abc; ttwid=token" }),
    ).resolves.toEqual({
      authors: [{ avatarUrl: "", id: "", name: "默认作者" }],
      videos: [{
        author: "默认作者",
        authorId: "",
        isFollowing: false,
        publishedAt: 1_700_000_200,
        title: "默认收藏视频",
        url: "https://www.douyin.com/video/7649250336875613451",
      }],
    });
  });

  it("rejects missing login cookies before calling Douyin", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(collectDouyinFavorites({ cookie: "msToken=token" })).rejects.toMatchObject({
      code: "INVALID_COOKIE",
    } satisfies Partial<DouyinApiError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates a credential with only the self-profile request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      status_code: 0,
      user: { sec_uid: "self-sec" },
    })));

    await expect(validateDouyinCredential("sessionid=abc; ttwid=token")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe("/aweme/v1/web/user/profile/self/");
  });

  it("rejects a credential when the self profile is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      status_code: 0,
      user: {},
    })));

    await expect(validateDouyinCredential("sessionid=expired")).rejects.toMatchObject({
      code: "LOGIN_REQUIRED",
    } satisfies Partial<DouyinApiError>);
  });

  it("uses one upstream request when credential validation is unavailable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("service unavailable", { status: 503 }),
    );

    await expect(validateDouyinCredential("sessionid=abc")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    } satisfies Partial<DouyinApiError>);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
