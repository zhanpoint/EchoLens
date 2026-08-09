import { describe, expect, it } from "vitest";
import { OPEN_API_BASE_PATH, OPEN_API_ENDPOINTS } from "@/lib/open-api/spec";

type JsonRecord = Record<string, any>;

describe("Open API documentation contract", () => {
  it("documents every catalog endpoint with request and response examples", () => {
    expect(OPEN_API_ENDPOINTS).toHaveLength(2);
    for (const endpoint of OPEN_API_ENDPOINTS) {
      expect(endpoint.path).toMatch(/^\//);
      expect(endpoint.variants.length).toBeGreaterThan(0);
      for (const variant of endpoint.variants) {
        expect(variant.response).toBeDefined();
        if (endpoint.method === "POST") {
          expect(variant.request).toBeDefined();
        }
      }
    }
  });

  it("keeps the public base path stable", () => {
    expect(OPEN_API_BASE_PATH).toBe("/api/open");
  });

  it("keeps platform-specific media examples paired with responses", () => {
    const media = OPEN_API_ENDPOINTS.find((endpoint) => endpoint.path === "/media/resolve");
    expect(media?.title).toBe("解析媒体");
    expect(media?.variants.map((variant) => variant.label)).toEqual(["抖音", "Bilibili"]);
    expect(media?.variants.every((variant) => (
      Array.isArray(variant.request?.inputs) &&
      variant.request.inputs.length > 0 &&
      Array.isArray(variant.response.media) &&
      !variant.response.work &&
      !variant.response.historyRecord
    ))).toBe(true);
    expect(media?.variants[0].response.media).toMatchObject([{
      source: "douyin",
      downloads: {
        audioUrl: expect.any(String),
        videoUrl: expect.any(String),
      },
    }]);
    expect(media?.variants[0].response).not.toHaveProperty("media.0.downloads.ossVideoUrl");
    expect(media?.variants[1].response.media).toMatchObject([{
      source: "bilibili",
      downloads: { audioUrl: expect.any(String), videoUrl: expect.any(String) },
    }]);
    const bilibiliMedia = media?.variants[1].response.media as JsonRecord[] | undefined;
    const bilibiliAudioUrl = String(bilibiliMedia?.[0]?.downloads?.audioUrl ?? "");
    expect(bilibiliAudioUrl).toContain("/echolens/open-api/audio/bilibili/");
    expect(bilibiliAudioUrl).not.toContain("bilivideo.com");
  });

  it("documents complete one-shot transcription response shape", () => {
    const transcript = OPEN_API_ENDPOINTS.find((endpoint) => endpoint.path === "/transcripts/transcribe");
    expect(transcript?.variants.every((variant) => {
      const media = variant.response.media as JsonRecord | undefined;
      const transcript = variant.response.transcript as JsonRecord | undefined;
      return Boolean(
        media &&
        !Array.isArray(media) &&
        media.downloads?.audioUrl &&
        media.downloads?.videoUrl &&
        transcript?.text &&
        Array.isArray(transcript.segments),
      );
    })).toBe(true);
    const bilibiliMedia = transcript?.variants[1].response.media as JsonRecord | undefined;
    const bilibiliAudioUrl = String(bilibiliMedia?.downloads?.audioUrl ?? "");
    expect(bilibiliAudioUrl).toContain("/echolens/open-api/audio/bilibili/");
    expect(bilibiliAudioUrl).not.toContain("bilivideo.com");
  });

  it("documents only one-shot JSON responses", () => {
    expect(OPEN_API_ENDPOINTS.every((endpoint) => endpoint.transport === "json")).toBe(true);
    const contract = JSON.stringify(OPEN_API_ENDPOINTS);
    expect(contract).not.toContain("jobId");
    expect(contract).not.toContain("historyRecordId");
    expect(contract).not.toContain("events");
  });
});