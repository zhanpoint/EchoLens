import { describe, expect, it } from "vitest";
import { buildTranscribeWorkPayload } from "@/lib/douyin/transcribe-request";

describe("transcribe request", () => {
  it("keeps the API payload stable when presentation metadata is added to a work", () => {
    expect(buildTranscribeWorkPayload({
      authorAvatarUrl: "https://example.com/avatar.jpg",
      authorName: "作者",
      authorUrl: "https://www.douyin.com/user/test",
      durationSeconds: 12,
      finalUrl: "https://www.douyin.com/video/7649250336875613449",
      id: "7649250336875613449",
      inputUrl: "https://v.douyin.com/test/",
      kind: "video",
      caption: "作品标题",
    })).toEqual({
      authorName: "作者",
      authorUrl: "https://www.douyin.com/user/test",
      durationSeconds: 12,
      finalUrl: "https://www.douyin.com/video/7649250336875613449",
      id: "7649250336875613449",
      inputUrl: "https://v.douyin.com/test/",
      kind: "video",
      caption: "作品标题",
    });
  });
});
