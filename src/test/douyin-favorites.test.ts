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

  it("preserves favorite folders and mixes with their display fields", async () => {
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

      if (url.pathname === "/aweme/v1/web/aweme/listcollection/") {
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
            { collects_id: 101, collects_id_str: "folder-1", collects_name: "科技", is_private: 1 },
            { collects_info: { collects_id: "folder-2", collects_name: "生活", is_private: 0 } },
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
                aweme_count: 86,
                avatar_thumb: { url_list: ["https://example.com/author-1.jpg"] },
                follow_status: 1,
                follower_count: 12_345,
                nickname: "作者一",
                sec_uid: "author-1",
                signature: "科技分享",
                unique_id: "tech-one",
              },
              aweme_id: "7649250336875613449",
              create_time: 1_700_000_000,
              desc: "第一条视频",
              statistics: { collect_count: 678, comment_count: 90, digg_count: 12_345 },
              video: { cover: { url_list: ["https://example.com/video-1.jpg"] } },
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

      if (url.pathname === "/aweme/v1/web/mix/listcollection/") {
        return new Response(JSON.stringify({
          mix_infos: [{
            mix_info: {
              aweme_count: 2,
              cover_url: { url_list: ["https://example.com/mix.jpg"] },
              mix_id: "mix-1",
              mix_name: "知识合集",
              play_count: 123_456,
            },
          }],
          cursor: 0,
          has_more: 0,
          status_code: 0,
        }));
      }

      if (url.pathname === "/aweme/v1/web/mix/aweme/" && url.searchParams.get("mix_id") === "mix-1") {
        return new Response(JSON.stringify({
          aweme_list: [{
            author: { nickname: "作者三", sec_uid: "author-3" },
            aweme_id: "7649250336875613452",
            create_time: 1_700_000_300,
            desc: "合集第一集",
            statistics_v2: { collect_count: "333", comment_count: "44", digg_count: "22000" },
            video: { origin_cover: { url_list: ["https://example.com/mix-video.jpg"] } },
          }],
          cursor: 0,
          has_more: 0,
          status_code: 0,
        }));
      }

      return new Response("{}", { status: 404 });
    });

    await expect(
      collectDouyinFavorites({ cookie: "sessionid=abc; msToken=token" }),
    ).resolves.toEqual({
      authors: [
        {
          avatarUrl: "https://example.com/author-1.jpg",
          followerCount: 12_345,
          id: "author-1",
          name: "作者一",
          signature: "科技分享",
          uniqueId: "tech-one",
          workCount: 86,
        },
        { avatarUrl: "", followerCount: 0, id: "author-2", name: "作者二", signature: "", uniqueId: "", workCount: 0 },
        { avatarUrl: "", followerCount: 0, id: "author-3", name: "作者三", signature: "", uniqueId: "", workCount: 0 },
      ],
      folders: [{
        id: "folder-1",
        isPrivate: true,
        name: "科技",
        total: 1,
        works: [{
          author: "作者一",
          authorId: "author-1",
          commentCount: 90,
          coverUrl: "https://example.com/video-1.jpg",
          favoriteCount: 678,
          isFollowing: true,
          likeCount: 12_345,
          publishedAt: 1_700_000_000,
          title: "第一条视频",
          url: "https://www.douyin.com/video/7649250336875613449",
        }],
      }, {
        id: "folder-2",
        isPrivate: false,
        name: "生活",
        total: 2,
        works: [{
          author: "作者一",
          authorId: "",
          commentCount: 0,
          coverUrl: "",
          favoriteCount: 0,
          isFollowing: false,
          likeCount: 0,
          publishedAt: 0,
          title: "重复视频",
          url: "https://www.douyin.com/video/7649250336875613449",
        }, {
          author: "作者二",
          authorId: "author-2",
          commentCount: 0,
          coverUrl: "",
          favoriteCount: 0,
          isFollowing: false,
          likeCount: 0,
          publishedAt: 1_700_000_100,
          title: "第二条视频",
          url: "https://www.douyin.com/video/7649250336875613450",
        }],
      }],
      mixes: [{
        coverUrl: "https://example.com/mix.jpg",
        id: "mix-1",
        name: "知识合集",
        playCount: 123_456,
        total: 2,
        url: "https://www.douyin.com/collection/mix-1",
        works: [{
          author: "作者三",
          authorId: "author-3",
          commentCount: 44,
          coverUrl: "https://example.com/mix-video.jpg",
          favoriteCount: 333,
          isFollowing: false,
          likeCount: 22_000,
          publishedAt: 1_700_000_300,
          title: "合集第一集",
          url: "https://www.douyin.com/video/7649250336875613452",
        }],
      }],
      videos: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("expands favorite groups with bounded concurrency while preserving order", async () => {
    let activeRequests = 0;
    let peakRequests = 0;
    const folderIds = Array.from({ length: 3 }, (_, index) => `folder-${index}`);
    const mixIds = Array.from({ length: 3 }, (_, index) => `mix-${index}`);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/aweme/v1/web/user/profile/self/") {
        return new Response(JSON.stringify({ status_code: 0, user: { sec_uid: "self-sec" } }));
      }
      if (url.pathname === "/aweme/v1/web/aweme/listcollection/") {
        return new Response(JSON.stringify({ aweme_list: [], has_more: 0, max_cursor: 0 }));
      }
      if (url.pathname === "/aweme/v1/web/collects/list/") {
        return new Response(JSON.stringify({
          collects_list: folderIds.map((id) => ({ collects_id_str: id, collects_name: id })),
          cursor: 0,
          has_more: 0,
        }));
      }
      if (url.pathname === "/aweme/v1/web/mix/listcollection/") {
        return new Response(JSON.stringify({
          mix_infos: mixIds.map((id) => ({ mix_id: id, mix_name: id })),
          cursor: 0,
          has_more: 0,
        }));
      }
      if (url.pathname === "/aweme/v1/web/collects/video/list/" || url.pathname === "/aweme/v1/web/mix/aweme/") {
        const groupId = url.searchParams.get("collects_id") ?? url.searchParams.get("mix_id") ?? "";
        activeRequests += 1;
        peakRequests = Math.max(peakRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeRequests -= 1;
        return new Response(JSON.stringify({
          aweme_list: [{
            author: { nickname: "作者" },
            aweme_id: `aweme-${groupId}`,
            desc: groupId,
          }],
          cursor: 0,
          has_more: 0,
        }));
      }
      return new Response("{}", { status: 404 });
    });

    const result = await collectDouyinFavorites({ cookie: "sessionid=abc; msToken=token" });

    expect(result.folders.map((folder) => folder.id)).toEqual(folderIds);
    expect(result.mixes.map((mix) => mix.id)).toEqual(mixIds);
    expect(peakRequests).toBe(1);
  });

  it("caps each favorite category at 5000 works", async () => {
    const makeWorks = (prefix: string) => Array.from({ length: 5_001 }, (_, index) => ({
      author: { nickname: "作者" },
      aweme_id: `${prefix}-${index}`,
      desc: `${prefix}-${index}`,
    }));

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/aweme/v1/web/user/profile/self/") {
        return new Response(JSON.stringify({ status_code: 0, user: { sec_uid: "self-sec" } }));
      }
      if (url.pathname === "/aweme/v1/web/aweme/listcollection/") {
        return new Response(JSON.stringify({ aweme_list: makeWorks("video"), has_more: 0, max_cursor: 0 }));
      }
      if (url.pathname === "/aweme/v1/web/collects/list/") {
        return new Response(JSON.stringify({
          collects_list: [{ collects_id_str: "folder-1", total_number: 5_001 }],
          cursor: 0,
          has_more: 0,
        }));
      }
      if (url.pathname === "/aweme/v1/web/collects/video/list/") {
        return new Response(JSON.stringify({ aweme_list: makeWorks("folder"), cursor: 0, has_more: 0 }));
      }
      if (url.pathname === "/aweme/v1/web/mix/listcollection/") {
        return new Response(JSON.stringify({
          mix_infos: [{ aweme_count: 5_001, mix_id: "mix-1" }],
          cursor: 0,
          has_more: 0,
        }));
      }
      if (url.pathname === "/aweme/v1/web/mix/aweme/") {
        return new Response(JSON.stringify({ aweme_list: makeWorks("mix"), cursor: 0, has_more: 0 }));
      }
      return new Response("{}", { status: 404 });
    });

    const result = await collectDouyinFavorites({ cookie: "sessionid=abc; msToken=token" });

    expect(result.videos).toHaveLength(5_000);
    expect(result.folders[0].works).toHaveLength(5_000);
    expect(result.mixes[0].works).toHaveLength(5_000);
  });

  it("reads the logged-in account favorite stream even when collect folders are empty", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname === "/aweme/v1/web/user/profile/self/") {
        return new Response(JSON.stringify({
          status_code: 0,
          user: { sec_uid: "self-sec" },
        }));
      }

      if (url.pathname === "/aweme/v1/web/aweme/listcollection/") {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe("count=20&cursor=0");
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

      if (url.pathname === "/aweme/v1/web/mix/listcollection/") {
        return new Response(JSON.stringify({
          mix_infos: [],
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
      authors: [{ avatarUrl: "", followerCount: 0, id: "", name: "默认作者", signature: "", uniqueId: "", workCount: 0 }],
      folders: [],
      mixes: [],
      videos: [{
        author: "默认作者",
        authorId: "",
        commentCount: 0,
        coverUrl: "",
        favoriteCount: 0,
        isFollowing: false,
        likeCount: 0,
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

  it("classifies a forbidden upstream response as access blocking", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));

    await expect(validateDouyinCredential("sessionid=abc")).rejects.toMatchObject({
      code: "ACCESS_BLOCKED",
      details: { endpoint: "/aweme/v1/web/user/profile/self/", status: 403 },
    });
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
