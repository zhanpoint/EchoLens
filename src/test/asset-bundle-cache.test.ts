import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audioCleanup: vi.fn(),
  deleteOssObjects: vi.fn(),
  fetchRemoteMedia: vi.fn(),
  getOssObjectInfo: vi.fn(),
  probeTranscribableAudioFromUrl: vi.fn(),
  putOssStream: vi.fn(),
  requestedSources: [] as string[][],
  createTranscribableAudioFileFromNode: vi.fn(),
  videoInputChunks: [] as Uint8Array[],
}));

vi.mock("@/lib/media/audio", () => ({
  fetchRemoteMedia: mocks.fetchRemoteMedia,
  probeTranscribableAudioFromUrl: mocks.probeTranscribableAudioFromUrl,
  createTranscribableAudioFileFromNode: mocks.createTranscribableAudioFileFromNode,
}));
vi.mock("@/lib/oss/object-store", () => ({
  createOssSignedUrl: vi.fn((objectKey: string) => `https://cache/${objectKey}`),
  deleteOssObjects: mocks.deleteOssObjects,
  getOssObjectInfo: mocks.getOssObjectInfo,
  putOssStream: mocks.putOssStream,
}));

import {
  ensurePreparedAsset,
  prepareAssetBundle,
} from "@/lib/douyin/asset-bundle";
import {
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";

const input = { id: "123456", kind: "video" as const, userId: "user-1" };
const metadata = {
  authorAvatarUrls: ["https://origin/avatar"],
  coverUrls: ["https://origin/cover"],
  durationSeconds: 90,
  videoUrls: ["https://origin/video"],
};

describe("asset preparation pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestedSources.length = 0;
    mocks.videoInputChunks.length = 0;
    mocks.putOssStream.mockReset().mockResolvedValue(undefined);
    mocks.deleteOssObjects.mockReset().mockResolvedValue(undefined);
    mocks.getOssObjectInfo.mockImplementation(async (objectKey: string) => {
      const upload = [...mocks.putOssStream.mock.calls]
        .reverse()
        .map(([candidate]) => candidate)
        .find((candidate) => candidate.objectKey === objectKey);
      return upload
        ? {
            contentLength: 3,
            contentType: objectKey.endsWith("audio.m4a") ? "audio/mp4" : "video/mp4",
            metadata: upload.metadata ?? {},
          }
        : null;
    });
    mocks.probeTranscribableAudioFromUrl.mockResolvedValue(undefined);
    mocks.fetchRemoteMedia.mockImplementation(async (urls: string[]) => {
      mocks.requestedSources.push([...urls]);
      return new Response(new Uint8Array([urls[0].length, 2, 3]), {
        headers: { "content-type": urls[0].includes("video") ? "video/mp4" : "image/jpeg" },
      });
    });
    mocks.createTranscribableAudioFileFromNode.mockImplementation(async (source: Readable) => {
      for await (const chunk of source) {
        mocks.videoInputChunks.push(chunk as Uint8Array);
      }
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

  it("starts avatar, cover, and video only after explicit metadata is supplied", async () => {
    const preparation = prepareAssetBundle(input, metadata);
    const results = await Promise.all(Object.values(preparation.assets));
    await preparation.completed;

    expect(results.map((result) => result.asset).sort()).toEqual([
      "avatar",
      "cover",
      "originalAudio",
      "video",
    ]);
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledTimes(3);
    expect(mocks.requestedSources).toEqual(expect.arrayContaining([
      metadata.authorAvatarUrls,
      metadata.coverUrls,
      metadata.videoUrls,
    ]));
    const requestedSources = mocks.fetchRemoteMedia.mock.calls.map(([urls]) => urls as string[]);
    expect(requestedSources.every((urls) => urls.length === 0)).toBe(true);
    expect(requestedSources).not.toContain(metadata.authorAvatarUrls);
    expect(requestedSources).not.toContain(metadata.coverUrls);
    expect(requestedSources).not.toContain(metadata.videoUrls);
    expect(mocks.createTranscribableAudioFileFromNode).toHaveBeenCalledTimes(1);
    expect(mocks.videoInputChunks).toHaveLength(1);
    expect(Array.from(mocks.videoInputChunks[0])).toEqual([0, 0, 0]);
    expect(mocks.audioCleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps one stable video object and replaces it when quality changes", async () => {
    const lowest = await ensurePreparedAsset(
      { ...input, videoQuality: "lowest" },
      { ...metadata, videoUrls: ["https://origin/video-lowest"] },
      "video",
    );
    const highest = await ensurePreparedAsset(
      { ...input, videoQuality: "highest" },
      { ...metadata, videoUrls: ["https://origin/video-highest"] },
      "video",
    );
    const repeatedHighest = await ensurePreparedAsset(
      { ...input, videoQuality: "highest" },
      { ...metadata, videoUrls: ["https://origin/video-highest"] },
      "video",
    );

    expect(lowest.value.objectKey).toBe("echolens/media/video/123456/video");
    expect(highest.value.objectKey).toBe(lowest.value.objectKey);
    expect(repeatedHighest.value.objectKey).toBe(lowest.value.objectKey);
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledTimes(2);
    expect(mocks.putOssStream).toHaveBeenCalledTimes(2);
    expect(mocks.putOssStream.mock.calls.map(([upload]) => upload.objectKey)).toEqual([
      lowest.value.objectKey,
      lowest.value.objectKey,
    ]);
    expect(mocks.putOssStream.mock.calls.map(([upload]) => upload.metadata)).toEqual([
      { "echolens-video-quality": "lowest" },
      { "echolens-video-quality": "highest" },
    ]);
  });

  it("uploads video and extracts audio concurrently from one completed download", async () => {
    let finishVideoUpload: (() => void) | undefined;
    const videoUpload = new Promise<void>((resolve) => {
      finishVideoUpload = resolve;
    });
    mocks.putOssStream.mockImplementation(async (upload: { objectKey: string }) => {
      if (upload.objectKey.endsWith("/video")) await videoUpload;
    });

    const preparation = prepareAssetBundle(
      input,
      metadata,
    );
    let videoSettled = false;
    const video = preparation.assets.video.finally(() => {
      videoSettled = true;
    });

    await expect(preparation.assets.originalAudio).resolves.toMatchObject({
      asset: "originalAudio",
      value: { durationSeconds: 90, objectKey: expect.stringContaining("audio.m4a") },
    });
    expect(videoSettled).toBe(false);
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledWith(metadata.videoUrls, { range: undefined });

    finishVideoUpload?.();
    await expect(video).resolves.toMatchObject({ asset: "video" });
    await expect(preparation.completed).resolves.toBeUndefined();
  });

  it("reuses a persisted verified audio asset without extraction or probing", async () => {
    const verifiedAudio = {
      contentType: "audio/mp4" as const,
      durationSeconds: 90,
      objectKey: "echolens/media/video/123456/audio.m4a",
      sizeBytes: 3,
    };
    const preparation = prepareAssetBundle(input, metadata, { originalAudio: verifiedAudio });

    await expect(preparation.assets.originalAudio).resolves.toEqual({
      asset: "originalAudio",
      value: verifiedAudio,
    });
    await preparation.completed;

    expect(mocks.createTranscribableAudioFileFromNode).not.toHaveBeenCalled();
    expect(mocks.probeTranscribableAudioFromUrl).not.toHaveBeenCalled();
  });

  it("retries an image OSS upload five total attempts without downloading again", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    mocks.putOssStream
      .mockRejectedValueOnce(new Error("fetch failed: upload-1"))
      .mockRejectedValueOnce(new Error("fetch failed: upload-2"))
      .mockRejectedValueOnce(new Error("fetch failed: upload-3"))
      .mockRejectedValueOnce(new Error("fetch failed: upload-4"))
      .mockResolvedValueOnce(undefined);

    const task = ensurePreparedAsset(input, metadata, "avatar");
    await vi.runAllTimersAsync();

    await expect(task).resolves.toMatchObject({ asset: "avatar" });
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mocks.putOssStream).toHaveBeenCalledTimes(5);
  });

  it("normalizes five failed OSS uploads to the network error", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    mocks.putOssStream.mockRejectedValue(new Error("fetch failed: offline"));

    const task = ensurePreparedAsset(input, metadata, "cover");
    const rejection = expect(task).rejects.toEqual(expect.objectContaining({
      message: NETWORK_RETRY_ERROR_MESSAGE,
      name: NetworkRetryExhaustedError.name,
    }));
    await vi.runAllTimersAsync();

    await rejection;
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mocks.putOssStream).toHaveBeenCalledTimes(5);
  });

  it("reuses one video download while retrying its OSS upload", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    mocks.putOssStream
      .mockRejectedValueOnce(new Error("fetch failed: upload-1"))
      .mockRejectedValueOnce(new Error("fetch failed: upload-2"))
      .mockResolvedValueOnce(undefined);

    const task = ensurePreparedAsset(input, metadata, "video");
    await vi.runAllTimersAsync();

    await expect(task).resolves.toMatchObject({ asset: "video" });
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mocks.putOssStream).toHaveBeenCalledTimes(3);
  });

  it("re-extracts and re-uploads audio when the stored object cannot be decoded", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    mocks.probeTranscribableAudioFromUrl
      .mockRejectedValueOnce(new Error("Invalid data found when processing input"))
      .mockResolvedValueOnce(undefined);

    const task = ensurePreparedAsset(input, metadata, "originalAudio");
    await vi.runAllTimersAsync();

    await expect(task).resolves.toMatchObject({ asset: "originalAudio" });
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mocks.createTranscribableAudioFileFromNode).toHaveBeenCalledTimes(2);
    expect(mocks.putOssStream).toHaveBeenCalledTimes(2);
    expect(mocks.putOssStream).toHaveBeenLastCalledWith(expect.objectContaining({ cacheControl: "no-cache" }));
    expect(mocks.probeTranscribableAudioFromUrl).toHaveBeenCalledTimes(2);
    expect(mocks.deleteOssObjects).toHaveBeenCalledTimes(1);
  });

  it("replaces an unverified cached audio object and probes only the new upload", async () => {
    const audioKey = "echolens/media/video/123456/audio.m4a";
    mocks.getOssObjectInfo.mockImplementation(async (objectKey: string) => (
      objectKey === audioKey
        ? { contentLength: 3, contentType: "audio/mp4" }
        : null
    ));

    await expect(ensurePreparedAsset(input, metadata, "originalAudio")).resolves.toMatchObject({
      asset: "originalAudio",
      value: { objectKey: audioKey },
    });

    expect(mocks.deleteOssObjects).toHaveBeenCalledWith([audioKey]);
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mocks.putOssStream).toHaveBeenCalledTimes(1);
    expect(mocks.probeTranscribableAudioFromUrl).toHaveBeenCalledTimes(1);
  });

  it("creates and closes a fresh FFmpeg stream for each audio upload attempt", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    mocks.putOssStream
      .mockRejectedValueOnce(new Error("fetch failed: upload-1"))
      .mockRejectedValueOnce(new Error("fetch failed: upload-2"))
      .mockResolvedValueOnce(undefined);

    const task = ensurePreparedAsset(input, metadata, "originalAudio");
    await vi.runAllTimersAsync();

    await expect(task).resolves.toMatchObject({ asset: "originalAudio" });
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mocks.createTranscribableAudioFileFromNode).toHaveBeenCalledTimes(3);
    expect(mocks.audioCleanup).toHaveBeenCalledTimes(3);
    expect(mocks.deleteOssObjects).toHaveBeenCalledTimes(2);
  });
});