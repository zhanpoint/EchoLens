import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readDashScopeUserConfig: vi.fn(),
  releaseOpenApiAsrQuota: vi.fn(),
  reserveOpenApiAsrQuota: vi.fn(),
  resolveOpenTranscriptionMedia: vi.fn(),
  transcribeDashScopeAsrOnce: vi.fn(),
}));

vi.mock("@/lib/dashscope/asr", () => ({
  AsrQuotaExceededError: class AsrQuotaExceededError extends Error {},
  getDashScopeAsrModel: vi.fn((duration: number, models: Record<string, string>) => duration <= 300 ? "qwen-audio-3.1-asr-flash" : models.asrE1),
  PLATFORM_ASR_QUOTA_SECONDS: 3_600,
  transcribeDashScopeAsrOnce: mocks.transcribeDashScopeAsrOnce,
}));
vi.mock("@/lib/dashscope/user-credential", () => ({
  readDashScopeUserConfig: mocks.readDashScopeUserConfig,
}));
vi.mock("@/lib/open-api/media-resource", () => ({
  resolveOpenTranscriptionMedia: mocks.resolveOpenTranscriptionMedia,
}));
vi.mock("@/lib/transcript/db", () => ({
  releaseOpenApiAsrQuota: mocks.releaseOpenApiAsrQuota,
  reserveOpenApiAsrQuota: mocks.reserveOpenApiAsrQuota,
}));

import { createOpenTranscription } from "@/lib/open-api/operation-gateway";

const models = {
  asrE1: "asr-e1",
  summary: "summary",
  transcriptPostprocess: "postprocess",
  translation: "translation",
};

describe("Open API one-shot transcription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOpenTranscriptionMedia.mockResolvedValue({
      audioUrl: "https://public.example/audio.m4a",
      durationSeconds: 60,
      resource: {
        downloads: { audioUrl: "https://public.example/audio.m4a" },
        source: "douyin",
        title: "作品",
      },
      title: "作品",
    });
    mocks.reserveOpenApiAsrQuota.mockResolvedValue(true);
  });

  it("returns one JSON result using the reusable OSS audio URL", async () => {
    mocks.readDashScopeUserConfig.mockResolvedValue({
      customApiKey: "custom-key",
      customModels: models,
      platformModels: models,
    });
    mocks.transcribeDashScopeAsrOnce.mockResolvedValue({
      result: {
        asrModel: "qwen-audio-3.1-asr-flash",
        content: "转录正文",
        ok: true,
        transcriptSegments: [{ startSeconds: 0, endSeconds: 1, text: "转录正文" }],
      },
    });

    const response = await createOpenTranscription({
      input: "https://v.douyin.com/example",
      model: "e1",
      userId: "user-1",
    });

    await expect(response.json()).resolves.toEqual({
      media: {
        downloads: { audioUrl: "https://public.example/audio.m4a" },
        source: "douyin",
        title: "作品",
      },
      transcript: {
        model: "qwen-audio-3.1-asr-flash",
        segments: [{ startSeconds: 0, endSeconds: 1, text: "转录正文" }],
        text: "转录正文",
      },
    });
    expect(mocks.reserveOpenApiAsrQuota).not.toHaveBeenCalled();
    expect(mocks.transcribeDashScopeAsrOnce).toHaveBeenCalledWith(
      "user-1",
      "https://public.example/audio.m4a",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("retains only successful platform quota usage", async () => {
    mocks.readDashScopeUserConfig.mockResolvedValue({
      customModels: models,
      platformApiKey: "platform-key",
      platformModels: models,
    });
    mocks.transcribeDashScopeAsrOnce.mockResolvedValue({
      result: { content: "结果", ok: true },
    });

    const response = await createOpenTranscription({
      input: "https://b23.tv/example",
      userId: "user-1",
    });

    expect(response.status).toBe(200);
    expect(mocks.reserveOpenApiAsrQuota).toHaveBeenCalledWith({
      durationSeconds: 60,
      limitSeconds: 3_600,
      userId: "user-1",
    });
    expect(mocks.releaseOpenApiAsrQuota).not.toHaveBeenCalled();
  });

  it("releases a platform reservation when transcription fails", async () => {
    mocks.readDashScopeUserConfig.mockResolvedValue({
      customModels: models,
      platformApiKey: "platform-key",
      platformModels: models,
    });
    mocks.transcribeDashScopeAsrOnce.mockResolvedValue({
      result: { code: "error", detail: "上游失败", ok: false },
    });

    const response = await createOpenTranscription({
      input: "https://b23.tv/example",
      userId: "user-1",
    });

    expect(response.status).toBe(502);
    expect(mocks.releaseOpenApiAsrQuota).toHaveBeenCalledWith({
      durationSeconds: 60,
      userId: "user-1",
    });
  });
});