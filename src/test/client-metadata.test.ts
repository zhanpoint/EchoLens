import { describe, expect, it } from "vitest";
import { mergeWorkMetadata } from "@/lib/douyin/client-metadata";

const work = {
  caption: "初始标题",
  finalUrl: "https://www.douyin.com/video/700001",
  id: "700001",
  inputUrl: "https://v.douyin.com/example/",
  kind: "video" as const,
};

describe("client metadata updates", () => {
  it("supplements author metadata without changing the resolved caption", () => {
    expect(mergeWorkMetadata(work, {
      authorName: "即时作者",
    })).toMatchObject({
      authorName: "即时作者",
      caption: "初始标题",
    });
  });

  it("preserves fields that arrived in an earlier partial update", () => {
    const withAuthor = mergeWorkMetadata(work, { authorName: "作者" });

    expect(mergeWorkMetadata(withAuthor, { durationSeconds: 90 })).toMatchObject({
      authorName: "作者",
      caption: "初始标题",
      durationSeconds: 90,
    });
  });
});
