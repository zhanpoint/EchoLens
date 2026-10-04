import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  wbi: vi.fn(),
  tags: vi.fn(),
  credential: vi.fn(),
  beforeRequest: vi.fn(),
}));
vi.mock("@/lib/douyin/web-client", () => ({
  createDouyinWebClient: () => ({
    query: () => ({ aid: "6383" }),
    request: mocks.request,
  }),
}));
vi.mock("@/lib/douyin/account", () => ({
  readDouyinCredentialState: mocks.credential,
}));
vi.mock("@/lib/bilibili/client", () => ({ requestBilibiliWbiJson: mocks.wbi, requestBilibiliJson: mocks.tags }));
vi.mock("@/lib/bilibili/account", () => ({
  readUsableBilibiliCookie: () => "",
}));
vi.mock("@/lib/user-settings", () => ({ readUserSetting: vi.fn() }));
vi.mock("@/lib/open-api/platform-request-policy", () => ({
  openApiPlatformRequestPolicy: {
    forUser: () => ({
      beforeRequest: mocks.beforeRequest,
      observePayload: vi.fn(),
    }),
  },
}));
import { fetchAuthorVideos, resolveAuthorId } from "@/lib/batch/author-videos";
import { AuthorVideoFiltersSchema } from "@/lib/batch/video-filters";
const secUid = "MS4wLjABAAAA1234567890abcd";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.credential.mockResolvedValue({ status: "valid", cookie: "cookie" });
});
describe("author video catalogues", () => {
  it("resolves canonical user profiles without downloading their HTML and rejects other hosts", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      resolveAuthorId("douyin", `https://www.douyin.com/user/${secUid}`),
    ).resolves.toBe(secUid);
    await expect(
      resolveAuthorId("bilibili", "https://space.bilibili.com/12345/video"),
    ).resolves.toBe("12345");
    await expect(
      resolveAuthorId("douyin", "http://localhost/private"),
    ).rejects.toThrow("对应平台");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
  it("uses upstream cursors, skips photo posts, and preserves pagination through empty video pages", async () => {
    mocks.request.mockResolvedValue({
      has_more: 1,
      max_cursor: 22,
      aweme_list: [{ aweme_id: "123456", desc: "图文", images: [{}] }],
    });
    await expect(
      fetchAuthorVideos({ platform: "douyin", authorId: secUid, userId: "u" }),
    ).resolves.toMatchObject({ cursor: "22", videos: [] });
    expect(mocks.request).toHaveBeenCalledWith(
      "/aweme/v1/web/aweme/post/",
      expect.objectContaining({
        sec_user_id: secUid,
        max_cursor: "0",
        count: 18,
      }),
      3,
    );
  });
  it("fails repeated cursors instead of looping or claiming all videos were loaded", async () => {
    mocks.request.mockResolvedValue({ has_more: 1, max_cursor: 22 });
    await expect(
      fetchAuthorVideos({
        platform: "douyin",
        authorId: secUid,
        cursor: "22",
        userId: "u",
      }),
    ).rejects.toThrow("未前进");
  });
  it("does not call Douyin without a verified credential", async () => {
    mocks.credential.mockResolvedValue({ status: "missing" });
    await expect(
      fetchAuthorVideos({ platform: "douyin", authorId: secUid, userId: "u" }),
    ).rejects.toThrow("凭证");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("maps Bilibili uploader archives and computes the next page from the real count", async () => {
    mocks.wbi.mockResolvedValue({
      data: {
        page: { count: 31 },
        list: {
          vlist: [
            {
              bvid: "BV1test",
              title: "视频",
              pic: "//img.example/cover",
              author: "UP",
              length: "01:02",
              created: 100,
            },
          ],
        },
      },
    });
    await expect(
      fetchAuthorVideos({ platform: "bilibili", authorId: "123", userId: "u" }),
    ).resolves.toMatchObject({
      cursor: "2",
      total: 31,
      videos: [
        {
          id: "BV1test",
          durationSeconds: 62,
          coverUrl: "https://img.example/cover",
        },
      ],
    });
    expect(mocks.tags).not.toHaveBeenCalled();
  });

  it.each([{ cursor: "1", total: 1 }, { cursor: "2", total: 31 }])("rejects an empty Bilibili page while the reported count still requires items: %o", async ({ cursor, total }) => {
    mocks.wbi.mockResolvedValue({ data: { page: { count: total }, list: { vlist: [] } } });
    await expect(fetchAuthorVideos({ platform: "bilibili", authorId: "123", userId: "u", cursor }))
      .rejects.toThrow("不完整分页");
  });

  it("accepts an empty Bilibili catalogue or a page beyond its current count", async () => {
    for (const [cursor, total] of [["1", 0], ["2", 30]]) {
      mocks.wbi.mockResolvedValue({ data: { page: { count: total }, list: { vlist: [] } } });
      await expect(fetchAuthorVideos({ platform: "bilibili", authorId: "123", userId: "u", cursor: String(cursor) }))
        .resolves.toMatchObject({ cursor: null, videos: [] });
    }
  });

  it("uses Douyin topic metadata and keeps the next cursor when a filter excludes the page", async () => {
    mocks.request.mockResolvedValue({
      has_more: 1, max_cursor: 22,
      aweme_list: [{ aweme_id: "123456", desc: "作品", create_time: 1, text_extra: [{ hashtag_name: "摄影" }], cha_list: [{ cha_name: "旅行" }] }],
    });
    const page = await fetchAuthorVideos({ platform: "douyin", authorId: secUid, userId: "u", filters: AuthorVideoFiltersSchema.parse({ tags: ["摄影", "旅行"], tagMode: "all" }) });
    expect(page.videos[0].tags).toEqual(["摄影", "旅行"]);
    await expect(fetchAuthorVideos({ platform: "douyin", authorId: secUid, userId: "u", filters: AuthorVideoFiltersSchema.parse({ publishedFrom: "2026-01-01" }) }))
      .resolves.toMatchObject({ cursor: "22", scannedCount: 1, videos: [] });
  });

  it("fetches Bilibili tags only for date and keyword candidates and propagates cancellation", async () => {
    const signal = new AbortController().signal;
    mocks.wbi.mockResolvedValue({ data: { page: { count: 3 }, list: { vlist: [
      { bvid: "BV1yes", title: "教程", created: Date.parse("2026-10-03T08:00:00+08:00") / 1000 },
      { bvid: "BV1old", title: "教程", created: 1 },
      { bvid: "BV1other", title: "其他", created: Date.parse("2026-10-03T08:00:00+08:00") / 1000 },
    ] } } });
    mocks.tags.mockResolvedValue({ data: [{ tag_name: "AI" }, { tag_name: "知识" }] });
    const filters = AuthorVideoFiltersSchema.parse({ publishedFrom: "2026-10-03", keyword: "教程", tags: ["#ai"] });
    const result = await fetchAuthorVideos({ platform: "bilibili", authorId: "123", userId: "u", filters, signal });
    expect(result.videos.map(({ id }) => id)).toEqual(["BV1yes"]);
    expect(result.scannedCount).toBe(3);
    expect(mocks.tags).toHaveBeenCalledOnce();
    expect(mocks.tags).toHaveBeenCalledWith("https://api.bilibili.com/x/tag/archive/tags?bvid=BV1yes", "", expect.any(Object), signal);
    expect(mocks.wbi.mock.calls[0][4]).toBe(signal);
  });

  it("does not dispatch another tag request after cancellation or hide tag failures", async () => {
    const controller = new AbortController();
    mocks.wbi.mockResolvedValue({ data: { page: { count: 2 }, list: { vlist: [{ bvid: "BV1first", title: "视频" }, { bvid: "BV1next", title: "视频" }] } } });
    mocks.tags.mockImplementationOnce(async () => { controller.abort(); return { data: [{ tag_name: "摄影" }] }; });
    const filters = AuthorVideoFiltersSchema.parse({ tags: ["摄影"] });
    await expect(fetchAuthorVideos({ platform: "bilibili", authorId: "123", userId: "u", filters, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.tags).toHaveBeenCalledOnce();
    mocks.tags.mockRejectedValueOnce(new Error("tag unavailable"));
    await expect(fetchAuthorVideos({ platform: "bilibili", authorId: "123", userId: "u", filters })).rejects.toThrow("tag unavailable");
  });
});
