import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOpenApiUser: vi.fn(),
  resolveOpenMediaResources: vi.fn(),
}));

vi.mock("@/lib/open-api/auth", () => ({ requireOpenApiUser: mocks.requireOpenApiUser }));
vi.mock("@/lib/open-api/media-resource", () => ({
  BilibiliApiError: class BilibiliApiError extends Error {},
  DouyinResolveError: class DouyinResolveError extends Error {},
  MediaRedirectError: class MediaRedirectError extends Error {},
  resolveOpenMediaResources: mocks.resolveOpenMediaResources,
}));

import { OpenApiPlatformCooldownError } from "@/lib/open-api/platform-request-policy";
import { POST } from "@/app/api/open/media/resolve/route";

describe("POST /api/open/media/resolve", () => {
  it("resolves an ordered list of media links", async () => {
    mocks.requireOpenApiUser.mockResolvedValue({ id: "user-1" });
    mocks.resolveOpenMediaResources.mockResolvedValue([
      { source: "douyin", title: "抖音作品" },
      { source: "bilibili", title: "Bilibili 作品" },
    ]);

    const response = await POST(new Request("http://localhost:3000/api/open/media/resolve", {
      body: JSON.stringify({ inputs: ["https://v.douyin.com/example", "https://b23.tv/example"] }),
      method: "POST",
    }));

    await expect(response.json()).resolves.toEqual({
      media: [
        { source: "douyin", title: "抖音作品" },
        { source: "bilibili", title: "Bilibili 作品" },
      ],
    });
    expect(mocks.resolveOpenMediaResources).toHaveBeenCalledWith({
      inputs: ["https://v.douyin.com/example", "https://b23.tv/example"],
      userId: "user-1",
    });
  });

  it("returns retry metadata while an upstream platform is cooling down", async () => {
    mocks.requireOpenApiUser.mockResolvedValue({ id: "user-1" });
    mocks.resolveOpenMediaResources.mockRejectedValue(new OpenApiPlatformCooldownError("douyin", 300));

    const response = await POST(new Request("http://localhost:3000/api/open/media/resolve", {
      body: JSON.stringify({ inputs: ["https://v.douyin.com/example"] }),
      method: "POST",
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("300");
    await expect(response.json()).resolves.toMatchObject({
      code: "UPSTREAM_RATE_LIMITED",
      retryAfterSeconds: 300,
    });
  });

  it("rejects the previous single-input shape", async () => {
    mocks.requireOpenApiUser.mockResolvedValue({ id: "user-1" });

    const response = await POST(new Request("http://localhost:3000/api/open/media/resolve", {
      body: JSON.stringify({ input: "https://v.douyin.com/example" }),
      method: "POST",
    }));

    expect(response.status).toBe(400);
  });
});