import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMediaUrl } from "@/lib/media/redirect";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("media redirect resolution", () => {
  it("manually requests a direct URL once before classifying it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await expect(resolveMediaUrl("https://www.douyin.com/video/123")).resolves.toEqual({
      finalUrl: "https://www.douyin.com/video/123",
      inputUrl: "https://www.douyin.com/video/123",
      source: "douyin",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("classifies the first redirect location without sending a second request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://www.bilibili.com/video/BV1xx411c7mD?p=2" },
    }));

    await expect(resolveMediaUrl("https://b23.tv/vU8bJum")).resolves.toMatchObject({
      finalUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
      source: "bilibili",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks for a full HTTP or HTTPS link before making a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(resolveMediaUrl("www.douyin.com/video/123")).rejects.toMatchObject({
      code: "invalid_url",
      message: "请重新输入带 http:// 或 https:// 的正确视频分享链接。",
    });
    await expect(resolveMediaUrl("BV1xx411c7mD")).rejects.toMatchObject({ code: "invalid_url" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a final URL from an unsupported platform", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://example.com/video/123" },
    }));

    await expect(resolveMediaUrl("https://short.example/video/123"))
      .rejects.toMatchObject({
        code: "unsupported_source",
        message: "暂不支持该链接来源，请粘贴抖音或 Bilibili 作品链接。",
      });
  });

  it("reports a network failure without retrying", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));

    await expect(resolveMediaUrl("https://v.douyin.com/network-failure/"))
      .rejects.toMatchObject({
        code: "network_error",
        message: "网络连接失败，请检查网络后重试。",
      });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});