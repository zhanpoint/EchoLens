import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireWorkMetadata: vi.fn(),
  ensureOpenAudioCache: vi.fn(),
  getBilibiliDashSelection: vi.fn(),
  isBilibiliBvid: vi.fn(),
  resolveBilibiliWork: vi.fn(),
  resolveDouyinUrl: vi.fn(),
  resolveMediaUrl: vi.fn(),
}));

vi.mock("@/lib/open-api/audio-cache", () => ({
  ensureOpenAudioCache: mocks.ensureOpenAudioCache,
}));
vi.mock("@/lib/bilibili/client", () => ({
  BilibiliApiError: class BilibiliApiError extends Error {},
  getBilibiliDashSelection: mocks.getBilibiliDashSelection,
  isBilibiliBvid: mocks.isBilibiliBvid,
  resolveBilibiliWork: mocks.resolveBilibiliWork,
}));
vi.mock("@/lib/douyin/metadata-coordinator", () => ({ acquireWorkMetadata: mocks.acquireWorkMetadata }));
vi.mock("@/lib/douyin/url", () => ({
  DouyinResolveError: class DouyinResolveError extends Error {},
  resolveDouyinUrl: mocks.resolveDouyinUrl,
}));
vi.mock("@/lib/media/redirect", () => ({
  MediaRedirectError: class MediaRedirectError extends Error {},
  resolveMediaUrl: mocks.resolveMediaUrl,
}));

import { resolveOpenMediaResources } from "@/lib/open-api/media-resource";

describe("open media resource projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isBilibiliBvid.mockReturnValue(false);
    mocks.ensureOpenAudioCache.mockResolvedValue({
      durationSeconds: 60,
      url: "https://public.example/audio.m4a",
    });
  });

  it("projects Douyin metadata with reusable OSS audio", async () => {
    const release = vi.fn();
    mocks.resolveMediaUrl.mockResolvedValue({
      finalUrl: "https://www.douyin.com/video/123",
      inputUrl: "https://v.douyin.com/example",
      source: "douyin",
    });
    mocks.resolveDouyinUrl.mockResolvedValue({ id: "123", kind: "video" });
    mocks.acquireWorkMetadata.mockResolvedValue({
      metadata: {
        authorAvatarUrls: ["https://douyin.example/avatar.jpg"],
        authorName: "抖音作者",
        caption: "抖音标题",
        coverUrls: ["https://douyin.example/cover.jpg"],
        durationSeconds: 60,
        videoUrls: ["https://douyin.example/video.mp4"],
      },
      release,
    });
    await expect(resolveOpenMediaResources({ inputs: ["https://v.douyin.com/example"], userId: "user-1" })).resolves.toEqual([{
      author: { avatarUrl: "https://douyin.example/avatar.jpg", name: "抖音作者" },
      coverUrl: "https://douyin.example/cover.jpg",
      downloads: {
        audioUrl: "https://public.example/audio.m4a",
        videoUrl: "https://douyin.example/video.mp4",
      },
      source: "douyin",
      title: "抖音标题",
    }]);
    expect(mocks.resolveDouyinUrl).toHaveBeenCalledWith(
      "https://v.douyin.com/example",
      { finalUrl: "https://www.douyin.com/video/123" },
    );
    expect(mocks.acquireWorkMetadata).toHaveBeenCalledWith(
      { id: "123", kind: "video" },
      undefined,
      expect.any(Object),
    );
    expect(mocks.ensureOpenAudioCache).toHaveBeenCalledWith({
      durationSeconds: 60,
      mediaId: "123",
      mediaSource: "douyin",
      sources: ["https://douyin.example/video.mp4"],
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("projects Bilibili DASH video and audio URLs", async () => {
    mocks.isBilibiliBvid.mockReturnValue(true);
    mocks.resolveBilibiliWork.mockResolvedValue({
      metadata: {
        authorAvatarUrls: ["https://bilibili.example/avatar.jpg"],
        authorName: "UP 主",
        bvid: "BV1xx411c7mD",
        caption: "Bilibili 标题",
        cid: 100,
        coverUrls: ["https://bilibili.example/cover.jpg"],
        durationSeconds: 60,
      },
    });
    mocks.getBilibiliDashSelection.mockResolvedValue({
      audio: { urls: ["https://bilibili.example/audio.m4s"] },
      video: { urls: ["https://bilibili.example/video.m4s"] },
    });

    await expect(resolveOpenMediaResources({ inputs: ["BV1xx411c7mD"], userId: "user-1" })).resolves.toEqual([{
      author: { avatarUrl: "https://bilibili.example/avatar.jpg", name: "UP 主" },
      coverUrl: "https://bilibili.example/cover.jpg",
      downloads: {
        audioUrl: "https://public.example/audio.m4a",
        videoUrl: "https://bilibili.example/video.m4s",
      },
      source: "bilibili",
      title: "Bilibili 标题",
    }]);
    expect(mocks.resolveBilibiliWork).toHaveBeenCalledWith(
      "BV1xx411c7mD",
      "",
      { requestPolicy: expect.any(Object) },
    );
    expect(mocks.getBilibiliDashSelection).toHaveBeenCalledWith({
      bvid: "BV1xx411c7mD",
      cid: 100,
      requestPolicy: expect.any(Object),
    });
    expect(mocks.ensureOpenAudioCache).toHaveBeenCalledWith({
      durationSeconds: 60,
      mediaId: "BV1xx411c7mD",
      mediaSource: "bilibili",
      sources: ["https://bilibili.example/audio.m4s"],
    });
  });

  it("uses default Bilibili downloads without account configuration", async () => {
    mocks.isBilibiliBvid.mockReturnValue(true);
    mocks.resolveBilibiliWork.mockResolvedValue({
      metadata: {
        authorAvatarUrls: ["https://bilibili.example/avatar.jpg"],
        authorName: "UP 主",
        bvid: "BV1xx411c7mD",
        caption: "Bilibili 标题",
        cid: 100,
        coverUrls: ["https://bilibili.example/cover.jpg"],
        durationSeconds: 60,
      },
    });
    mocks.getBilibiliDashSelection.mockResolvedValue({
      audio: { urls: ["https://bilibili.example/audio.m4s"] },
      video: { urls: ["https://bilibili.example/video.m4s"] },
    });

    await resolveOpenMediaResources({ inputs: ["BV1xx411c7mD"], userId: "user-1" });

    expect(mocks.getBilibiliDashSelection).toHaveBeenCalledWith({
      bvid: "BV1xx411c7mD",
      cid: 100,
      requestPolicy: expect.any(Object),
    });
  });
});