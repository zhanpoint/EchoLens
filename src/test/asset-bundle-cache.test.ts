import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audioCleanup: vi.fn(),
  createTranscribableAudioFileFromNode: vi.fn(),
  deleteOssObjects: vi.fn(),
  fetchRemoteMedia: vi.fn(),
  getOssObjectInfo: vi.fn(),
  probeTranscribableAudioFromUrl: vi.fn(),
  putOssStream: vi.fn(),
}));

vi.mock("@/lib/media/audio", () => ({
  createTranscribableAudioFileFromNode: mocks.createTranscribableAudioFileFromNode,
  fetchRemoteMedia: mocks.fetchRemoteMedia,
  probeTranscribableAudioFromUrl: mocks.probeTranscribableAudioFromUrl,
}));
vi.mock("@/lib/oss/object-store", () => ({
  createOssSignedUrl: vi.fn((objectKey: string) => `https://cache/${objectKey}`),
  deleteOssObjects: mocks.deleteOssObjects,
  getOssObjectInfo: mocks.getOssObjectInfo,
  putOssStream: mocks.putOssStream,
}));

import { prepareDouyinOriginalAudio } from "@/lib/douyin/asset-bundle";

const input = { id: "123456", kind: "video" as const, videoQuality: "lowest" as const };
const metadata = {
  audioUrls: ["https://origin/audio.m4a"],
  authorAvatarUrls: ["https://origin/avatar"],
  caption: "标题",
  coverUrls: ["https://origin/cover"],
  durationSeconds: 90,
  videoUrls: ["https://origin/video.mp4"],
};

describe("original-audio OSS pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteOssObjects.mockResolvedValue(undefined);
    mocks.putOssStream.mockResolvedValue(undefined);
    mocks.probeTranscribableAudioFromUrl.mockResolvedValue(undefined);
    mocks.getOssObjectInfo.mockImplementation(async (objectKey: string) => {
      const uploaded = mocks.putOssStream.mock.calls.some(([value]) => value.objectKey === objectKey);
      return uploaded ? { contentLength: 3, contentType: "audio/mp4", metadata: {} } : null;
    });
    mocks.fetchRemoteMedia.mockImplementation(async (urls: string[]) => new Response(
      new Uint8Array([1, 2, 3]),
      { headers: { "content-length": "3", "content-type": urls[0].includes("audio") ? "audio/mp4" : "video/mp4" } },
    ));
    mocks.createTranscribableAudioFileFromNode.mockImplementation(async (source: Readable) => {
      for await (const _chunk of source) void _chunk;
      return {
        cleanup: mocks.audioCleanup,
        contentType: "audio/mp4",
        durationSeconds: 90,
        filePath: `${process.cwd()}/package.json`,
        sizeBytes: 3,
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("streams independent Douyin audio directly to OSS and verifies it", async () => {
    await expect(prepareDouyinOriginalAudio(input, metadata)).resolves.toMatchObject({
      contentType: "audio/mp4",
      durationSeconds: 90,
      sizeBytes: 3,
    });

    expect(mocks.fetchRemoteMedia).toHaveBeenCalledWith(metadata.audioUrls, { mediaSource: "douyin" });
    expect(mocks.createTranscribableAudioFileFromNode).not.toHaveBeenCalled();
    expect(mocks.putOssStream).toHaveBeenCalledWith(expect.objectContaining({
      contentLength: 3,
      objectKey: "echolens/media/video/123456/audio.m4a",
    }));
    expect(mocks.probeTranscribableAudioFromUrl).toHaveBeenCalledOnce();
  });

  it("shares audio preparation across concurrent requests and releases failed tasks for retry", async () => {
    mocks.getOssObjectInfo.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(prepareDouyinOriginalAudio(input, metadata)).rejects.toThrow("storage unavailable");

    const results = await Promise.all(Array.from({ length: 10 }, () => prepareDouyinOriginalAudio(input, metadata)));
    expect(results.every((result) => result.objectKey === results[0].objectKey)).toBe(true);
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledOnce();
    expect(mocks.putOssStream).toHaveBeenCalledOnce();
    expect(mocks.probeTranscribableAudioFromUrl).toHaveBeenCalledOnce();

    await prepareDouyinOriginalAudio(input, metadata);
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledOnce();
  });

  it("falls back to streaming progressive video through FFmpeg when DASH audio is missing", async () => {
    await expect(prepareDouyinOriginalAudio(
      input,
      { ...metadata, audioUrls: [] },
    )).resolves.toMatchObject({ durationSeconds: 90 });

    expect(mocks.fetchRemoteMedia).toHaveBeenCalledWith(metadata.videoUrls, { mediaSource: "douyin" });
    expect(mocks.createTranscribableAudioFileFromNode).toHaveBeenCalledOnce();
    expect(mocks.putOssStream).toHaveBeenCalledOnce();
    expect(mocks.audioCleanup).toHaveBeenCalledOnce();
  });

  it("reuses one extracted file across upload retries without retaining the source video in memory", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    mocks.putOssStream
      .mockRejectedValueOnce(new Error("fetch failed: upload-1"))
      .mockRejectedValueOnce(new Error("fetch failed: upload-2"))
      .mockResolvedValueOnce(undefined);

    const task = prepareDouyinOriginalAudio(input, { ...metadata, audioUrls: [] });
    await vi.runAllTimersAsync();
    await expect(task).resolves.toMatchObject({ objectKey: expect.stringContaining("audio.m4a") });

    expect(mocks.fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mocks.createTranscribableAudioFileFromNode).toHaveBeenCalledTimes(1);
    expect(mocks.putOssStream).toHaveBeenCalledTimes(3);
    expect(mocks.audioCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.deleteOssObjects).toHaveBeenCalledTimes(2);
  });

  it("reuses an existing OSS audio object without downloading, uploading, or probing it", async () => {
    mocks.getOssObjectInfo.mockResolvedValueOnce({ contentLength: 9, contentType: "audio/mp4", metadata: {} });

    await expect(prepareDouyinOriginalAudio(input, metadata)).resolves.toMatchObject({
      contentType: "audio/mp4",
      durationSeconds: 90,
      objectKey: "echolens/media/video/123456/audio.m4a",
      sizeBytes: 9,
    });

    expect(mocks.fetchRemoteMedia).not.toHaveBeenCalled();
    expect(mocks.putOssStream).not.toHaveBeenCalled();
    expect(mocks.deleteOssObjects).not.toHaveBeenCalled();
    expect(mocks.probeTranscribableAudioFromUrl).not.toHaveBeenCalled();
  });
});
