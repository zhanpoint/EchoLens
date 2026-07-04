import { describe, expect, it } from "vitest";
import {
  isTrailingDouyinWatermarkText,
  stripTrailingDouyinWatermarkFromTranscript,
  stripTrailingDouyinWatermarkText,
} from "@/lib/transcript/normalize";

describe("transcript normalization", () => {
  it("recognizes punctuated Douyin trailing watermark segments", () => {
    expect(isTrailingDouyinWatermarkText("抖音。")).toBe(true);
    expect(isTrailingDouyinWatermarkText(" 抖 音！")).toBe(true);
    expect(isTrailingDouyinWatermarkText("douyin.")).toBe(true);
    expect(isTrailingDouyinWatermarkText("我在抖音看到的内容")).toBe(false);
  });

  it("removes only a trailing standalone Douyin watermark from content text", () => {
    expect(stripTrailingDouyinWatermarkText("真正的软件开发。抖音。")).toBe("真正的软件开发。");
    expect(stripTrailingDouyinWatermarkText("我在抖音看到的内容。")).toBe("我在抖音看到的内容。");
  });

  it("removes the final watermark segment before rendering or storing transcripts", () => {
    const normalized = stripTrailingDouyinWatermarkFromTranscript({
      content: "第一句。抖音。",
      transcriptSegments: [
        { startSeconds: 0, endSeconds: 5, text: "第一句。" },
        { startSeconds: 15, endSeconds: 16, text: "抖音。" },
      ],
    });

    expect(normalized).toEqual({
      content: "第一句。",
      transcriptSegments: [
        { startSeconds: 0, endSeconds: 5, text: "第一句。" },
      ],
    });
  });
});
