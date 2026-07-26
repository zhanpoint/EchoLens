import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/auth/_shared", () => ({
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));

vi.mock("@/lib/user-settings", () => ({
  readUserSettings: vi.fn(async () => ({
    douyin: {
      cookie: "sessionid=abc; ttwid=token",
      credentialCheckedAt: 1_234,
      credentialStatus: "valid",
    },
  })),
  upsertUserSetting: vi.fn(async () => undefined),
}));

vi.mock("@/lib/douyin/favorites", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/douyin/favorites")>();
  return {
    ...original,
    collectDouyinFavorites: vi.fn(async () => ({
      authors: [{ avatarUrl: "https://example.com/avatar.jpg", id: "fresh", name: "最新作者" }],
      videos: [{
          author: "最新作者",
          authorId: "fresh",
          commentCount: 3,
          favoriteCount: 2,
          isFollowing: false,
          likeCount: 10,
          publishedAt: 1_700_000_100,
          title: "最新标题",
          url: "https://www.douyin.com/video/2",
      }],
    })),
  };
});

import { requireUser } from "@/app/api/auth/_shared";
import { collectDouyinFavorites } from "@/lib/douyin/favorites";
import { POST } from "@/app/api/douyin/favorites/route";

const requireUserMock = vi.mocked(requireUser);
const collectMock = vi.mocked(collectDouyinFavorites);

describe("douyin favorites route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUserMock.mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
  });

  it("requires authentication", async () => {
    requireUserMock.mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));
    expect((await POST(new Request("https://echolens.test/api/douyin/favorites", { method: "POST" }))).status).toBe(401);
  });

  it("returns a fresh snapshot without server-side persistence", async () => {
    const response = await POST(new Request("https://echolens.test/api/douyin/favorites", { method: "POST" }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.videos[0].author).toBe("最新作者");
    expect(payload.refreshedAt).toEqual(expect.any(Number));
    expect(collectMock).toHaveBeenCalledOnce();
  });
});
