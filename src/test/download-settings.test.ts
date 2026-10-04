import { expect, it } from "vitest";
import { buildDirectorySegments } from "@/lib/download-settings";

it("builds download directories and sanitizes author and work names", () => {
  const context = {
    authorName: "作者:名称", contentType: "video/mp4",
    workId: "123456", caption: "作品/标题",
  };
  const now = new Date(2026, 6, 14, 9, 30, 0);
  expect({
    author: buildDirectorySegments("author", context, "sample.mp4", now),
    date: buildDirectorySegments("date", context, "sample.mp4", now),
    fileType: buildDirectorySegments("fileType", context, "sample.mp4", now),
    flat: buildDirectorySegments("flat", context, "sample.mp4", now),
    work: buildDirectorySegments("work", context, "sample.mp4", now),
  }).toEqual({
    author: ["作者_名称"], date: ["2026-07-14"], fileType: ["视频"], flat: [], work: ["作品_标题"],
  });
});
