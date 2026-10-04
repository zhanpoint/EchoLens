import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  download: vi.fn(), mux: vi.fn(), inputCleanup: vi.fn(), outputCleanup: vi.fn(),
}));
vi.mock("@/lib/media/range-downloader", () => ({ downloadMediaFile: mocks.download }));
vi.mock("@/lib/media/audio", () => ({
  mediaDownloadHeaders: (source: string) => ({ referer: `https://www.${source}.com/` }),
  muxVideoAndAudioToFile: mocks.mux,
}));
vi.mock("node:fs/promises", () => ({ stat: vi.fn(async () => ({ size: 42 })) }));

describe("temporary DASH video cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mocks.inputCleanup.mockResolvedValue(undefined);
    mocks.outputCleanup.mockResolvedValue(undefined);
    vi.stubGlobal("__echolensTemporaryVideoCache", new Map());
    vi.stubGlobal("__echolensTemporaryVideoTasks", new Map());
    vi.stubGlobal("__echolensTemporaryVideoTimer", undefined);
    mocks.download.mockImplementation(async (input) => ({
      cleanup: mocks.inputCleanup, contentType: "application/octet-stream", filePath: `/tmp/${input.name}`, sizeBytes: 10,
    }));
    mocks.mux.mockResolvedValue({ cleanup: mocks.outputCleanup, filePath: "/tmp/output.mp4", sizeBytes: 42 });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["bilibili", "douyin"] as const)("uses the bounded file downloader for %s and reuses concurrent results", async (source) => {
    const { ensureTemporaryMuxedVideo, acquireTemporaryVideo } = await import("@/lib/media/temporary-video-cache");
    const input = { audioUrls: ["https://cdn.example/audio"], cacheIdentity: "same-work", mediaSource: source, videoUrls: ["https://cdn.example/video"] };
    const [first, second] = await Promise.all([ensureTemporaryMuxedVideo(input), ensureTemporaryMuxedVideo(input)]);
    expect(first).toEqual(second);
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({
      headers: { referer: `https://www.${source}.com/` }, maxBytes: 1024 * 1024 * 1024, signal: expect.any(AbortSignal),
    }));
    expect(mocks.mux).toHaveBeenCalledOnce();
    expect(mocks.mux).toHaveBeenCalledWith("/tmp/video.m4s", "/tmp/audio.m4s", expect.any(Object));
    expect(mocks.inputCleanup).toHaveBeenCalledTimes(2);
    const lease = await acquireTemporaryVideo(first.cacheKey);
    expect(lease?.filePath).toBe("/tmp/output.mp4");
    expect(mocks.outputCleanup).not.toHaveBeenCalled();
    lease?.release();
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(mocks.outputCleanup).toHaveBeenCalledOnce();
  });

  it("cleans up a completed input when its companion fails and lets retry restart", async () => {
    const { ensureTemporaryMuxedVideo } = await import("@/lib/media/temporary-video-cache");
    mocks.download.mockRejectedValueOnce(new Error("CDN unavailable"));
    const input = { audioUrls: ["https://cdn.example/audio"], cacheIdentity: "failed-work", mediaSource: "bilibili" as const, videoUrls: ["https://cdn.example/video"] };
    await expect(ensureTemporaryMuxedVideo(input)).rejects.toThrow("CDN unavailable");
    expect(mocks.inputCleanup).toHaveBeenCalledOnce();
    expect(mocks.mux).not.toHaveBeenCalled();
    await expect(ensureTemporaryMuxedVideo(input)).resolves.toMatchObject({ sizeBytes: 42 });
    expect(mocks.mux).toHaveBeenCalledOnce();
  });

  it("aborts a still-running companion before reporting download failure", async () => {
    const { ensureTemporaryMuxedVideo } = await import("@/lib/media/temporary-video-cache");
    let aborted = false;
    mocks.download.mockImplementation(async (input) => {
      if (input.name === "audio.m4s") throw new Error("audio failed");
      return await new Promise((_resolve, reject) => {
        input.signal.addEventListener("abort", () => { aborted = true; reject(input.signal.reason); }, { once: true });
      });
    });
    await expect(ensureTemporaryMuxedVideo({ audioUrls: ["audio"], videoUrls: ["video"], cacheIdentity: "abort-work", mediaSource: "douyin" }))
      .rejects.toThrow("audio failed");
    expect(aborted).toBe(true);
    expect(mocks.mux).not.toHaveBeenCalled();
  });
});
