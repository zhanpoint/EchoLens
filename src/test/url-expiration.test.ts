import { describe, expect, it } from "vitest";
import { inferSourceUrlsExpiresAt, sourceUrlsNeedRefresh } from "@/lib/media/url-expiration";

const NOW = 1_700_000_000_000;

describe("source URL expiration", () => {
  it("does not invent an expiration for URLs without explicit parameters", () => {
    expect(inferSourceUrlsExpiresAt([
      "https://example.com/video.mp4?token=opaque",
      "https://example.com/audio.m4a",
    ], NOW)).toBeUndefined();
    expect(sourceUrlsNeedRefresh(undefined, NOW)).toBe(false);
  });

  it("parses explicit epoch seconds and milliseconds", () => {
    expect(inferSourceUrlsExpiresAt([
      "https://example.com/video.mp4?expires=1700003600",
    ], NOW)).toBe(1_700_003_600_000);
    expect(inferSourceUrlsExpiresAt([
      "https://example.com/audio.m4a?expiration=1700007200000",
    ], NOW)).toBe(1_700_007_200_000);
  });

  it("uses the earliest explicit expiration across all upstream URLs", () => {
    expect(inferSourceUrlsExpiresAt([
      "https://example.com/avatar.webp?deadline=1700007200",
      "https://example.com/video.mp4?expire=1700003600",
      "https://example.com/audio.m4a",
    ], NOW)).toBe(1_700_003_600_000);
  });

  it("enters the refresh window only for an explicit expiration", () => {
    expect(sourceUrlsNeedRefresh(NOW + 5 * 60_000, NOW)).toBe(true);
    expect(sourceUrlsNeedRefresh(NOW + 5 * 60_000 + 1, NOW)).toBe(false);
    expect(sourceUrlsNeedRefresh(undefined, NOW)).toBe(false);
  });
});