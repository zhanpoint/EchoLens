import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/media/audio", () => ({
  transcodeAudioToMp3Chunks: vi.fn(),
}));

import { transcodeAudioToMp3Chunks } from "../lib/media/audio";
import { summarizeTranscript, transcribeMediaSource } from "../lib/openrouter/provider";

describe("openrouter audio transcription", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_ASR_MODEL: "qwen/qwen3-asr-flash-2026-02-10",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
    };
    vi.mocked(transcodeAudioToMp3Chunks).mockReset();
    vi.mocked(transcodeAudioToMp3Chunks).mockResolvedValue([
      { buffer: Buffer.from("mp3-data"), endSeconds: 300, format: "mp3", startSeconds: 0 },
    ]);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("uses the caller-provided missing media detail", async () => {
    await expect(transcribeMediaSource("user-1", "video:1", undefined, "没有采集到当前作品对应的视频资源。")).resolves.toEqual({
      ok: false,
      code: "unavailable",
      detail: "没有采集到当前作品对应的视频资源。",
    });
    expect(transcodeAudioToMp3Chunks).not.toHaveBeenCalled();
  });

  it("transcribes large audio chunks without a local byte-limit setting", async () => {
    vi.mocked(transcodeAudioToMp3Chunks).mockResolvedValue([
      { buffer: Buffer.alloc(12 * 1024 * 1024), endSeconds: 300, format: "mp3", startSeconds: 0 },
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "大音频转录成功" }), { status: 200 }),
    );

    await expect(transcribeMediaSource("user-1", "video:large", "https://example.com/large-video.mp4")).resolves.toEqual({
      ok: true,
      content: "大音频转录成功",
      transcriptSegments: [
        { endSeconds: 300, startSeconds: 0, text: "大音频转录成功" },
      ],
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("transcribes chunked audio in order and joins the transcript continuously", async () => {
    vi.mocked(transcodeAudioToMp3Chunks).mockResolvedValue([
      { buffer: Buffer.from("chunk-1"), endSeconds: 300, format: "mp3", startSeconds: 0 },
      { buffer: Buffer.from("chunk-2"), endSeconds: 600, format: "mp3", startSeconds: 300 },
    ]);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "第一段" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "第二段" }), { status: 200 }));

    await expect(transcribeMediaSource("user-1", "video:long", "https://example.com/long-video.mp4")).resolves.toEqual({
      ok: true,
      content: "第一段第二段",
      transcriptSegments: [
        { endSeconds: 300, startSeconds: 0, text: "第一段" },
        { endSeconds: 600, startSeconds: 300, text: "第二段" },
      ],
    });
    expect(transcodeAudioToMp3Chunks).toHaveBeenCalledWith("user-1", "https://example.com/long-video.mp4", 300);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("summarizes transcript with the DeepSeek flash model", async () => {
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
        body: expect.stringContaining('"model":"deepseek/deepseek-v4-flash"'),
      }),
    );
  });

  it("retries a 429 response once and caches the successful transcript by user and source url", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Provider returned 429" } }), {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "转录成功" }), { status: 200 }));

    await expect(transcribeMediaSource("user-1", "video:cache", "https://example.com/video.mp4")).resolves.toEqual({
      ok: true,
      content: "转录成功",
      transcriptSegments: [
        { endSeconds: 300, startSeconds: 0, text: "转录成功" },
      ],
    });
    await expect(transcribeMediaSource("user-1", "video:cache", "https://example.com/video.mp4")).resolves.toEqual({
      ok: true,
      content: "转录成功",
      transcriptSegments: [
        { endSeconds: 300, startSeconds: 0, text: "转录成功" },
      ],
    });

    expect(transcodeAudioToMp3Chunks).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps transcript cache scoped to the user's current work", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "第一个作品" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "第二个作品" }), { status: 200 }));

    await expect(transcribeMediaSource("user-1", "video:first", "https://example.com/video.mp4")).resolves.toMatchObject({
      ok: true,
      content: "第一个作品",
    });
    await expect(transcribeMediaSource("user-1", "video:second", "https://example.com/video.mp4")).resolves.toMatchObject({
      ok: true,
      content: "第二个作品",
    });

    expect(transcodeAudioToMp3Chunks).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a clear message after retry exhaustion on 429", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: "Provider returned 429" } }), {
        status: 429,
        headers: { "retry-after": "0" },
      }),
    );

    await expect(transcribeMediaSource("user-1", "video:rate-limited", "https://example.com/rate-limited-video.mp4")).resolves.toEqual({
      ok: false,
      code: "error",
      detail: expect.stringContaining("限流"),
    });
    expect(transcodeAudioToMp3Chunks).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});
