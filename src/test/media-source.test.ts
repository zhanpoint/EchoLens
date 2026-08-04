import { describe, expect, it } from "vitest";
import {
  buildWorkKey,
  extractHttpUrl,
  mediaSourceFromUrl,
  mediaSourceFromWorkKey,
  parseHttpUrl,
} from "@/lib/media/source";

describe("media source detection", () => {
  it("extracts and validates only HTTP or HTTPS URLs", () => {
    expect(extractHttpUrl("分享 https://v.douyin.com/abc/: 打开应用")).toEqual({
      index: 3,
      value: "https://v.douyin.com/abc/",
    });
    expect(extractHttpUrl("www.douyin.com/video/123")).toBeNull();
    expect(extractHttpUrl("ftp://www.douyin.com/video/123")).toBeNull();
    expect(extractHttpUrl("prefixhttps://www.douyin.com/video/123")).toBeNull();
    expect(parseHttpUrl("/video/123", "https://www.douyin.com")?.toString())
      .toBe("https://www.douyin.com/video/123");
  });

  it("classifies platforms from the parsed hostname", () => {
    expect(mediaSourceFromUrl("https://www.douyin.com/video/123")).toBe("douyin");
    expect(mediaSourceFromUrl("https://www.bilibili.com/video/BV123")).toBe("bilibili");
    expect(mediaSourceFromUrl("https://example.com/douyin/video/123")).toBeNull();
    expect(mediaSourceFromUrl("not a URL")).toBeNull();
  });

  it("keeps legacy Douyin keys and namespaces Bilibili keys", () => {
    expect(buildWorkKey({ id: "123456", kind: "video", source: "douyin" })).toBe("video:123456");
    expect(buildWorkKey({ id: "BV1xx411c7mD:987", kind: "video", source: "bilibili" }))
      .toBe("bilibili:video:BV1xx411c7mD:987");
    expect(mediaSourceFromWorkKey("video:123456")).toBe("douyin");
    expect(mediaSourceFromWorkKey("bilibili:video:BV1xx411c7mD:987")).toBe("bilibili");
  });
});
