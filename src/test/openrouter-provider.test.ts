import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identifyImageContent, summarizeTranscript } from "../lib/openrouter/provider";

describe("openrouter provider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_MODEL: "vision-model",
      OPENROUTER_SUMMARY_MODEL: "summary-model",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("summarizes transcript with the configured summary model", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "总结完成" } }] }), { status: 200 }));

    await expect(summarizeTranscript("原始文本", "请总结")).resolves.toEqual({
      ok: true,
      content: "总结完成",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.test/api/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"model":"summary-model"'),
      }),
    );
  });

  it("sends image URLs through the configured multimodal model", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "图片文字" } }] }), { status: 200 }));

    await expect(identifyImageContent(["https://example.com/1.jpg"])).resolves.toEqual({
      ok: true,
      content: "图片文字",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.test/api/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"model":"vision-model"'),
      }),
    );
  });

  it("returns not_configured when OpenRouter API key is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;

    await expect(summarizeTranscript("原始文本", "请总结")).resolves.toEqual({
      ok: false,
      code: "not_configured",
      detail: "OPENROUTER_API_KEY 未配置。",
    });
  });
});
