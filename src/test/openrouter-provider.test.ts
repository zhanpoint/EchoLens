import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/media/audio", () => ({
  normalizeAudioToWav: vi.fn(),
}));

import { normalizeAudioToWav } from "../lib/media/audio";
import { transcribeMediaSource } from "../lib/openrouter/provider";

describe("openrouter audio transcription", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_ASR_MODEL: "qwen/qwen3-asr-flash-2026-02-10",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      EXTRACTION_TIMEOUT_MS: "1000",
    };
    vi.mocked(normalizeAudioToWav).mockReset();
    vi.mocked(normalizeAudioToWav).mockResolvedValue(Buffer.from("wav-data"));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("retries a 429 response once and caches the successful transcript by source url", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Provider returned 429" } }), {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "转录成功" }), { status: 200 }));

    await expect(transcribeMediaSource("https://example.com/audio.m4a")).resolves.toEqual({
      ok: true,
      content: "转录成功",
    });
    await expect(transcribeMediaSource("https://example.com/audio.m4a")).resolves.toEqual({
      ok: true,
      content: "转录成功",
    });

    expect(normalizeAudioToWav).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a clear message after retry exhaustion on 429", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: "Provider returned 429" } }), {
        status: 429,
        headers: { "retry-after": "0" },
      }),
    );

    await expect(transcribeMediaSource("https://example.com/rate-limited.m4a")).resolves.toEqual({
      ok: false,
      code: "error",
      detail: expect.stringContaining("限流"),
    });
    expect(normalizeAudioToWav).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});
