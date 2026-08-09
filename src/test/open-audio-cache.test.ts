import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audioCleanup: vi.fn(),
  buildConfiguredPublicOssObjectUrl: vi.fn(),
  createTranscribableAudioFileFromNode: vi.fn(),
  fetchRemoteMedia: vi.fn(),
  getPublicOssObjectInfo: vi.fn(),
  putPublicOssStream: vi.fn(),
}));

vi.mock("@/lib/media/audio", () => ({
  createTranscribableAudioFileFromNode: mocks.createTranscribableAudioFileFromNode,
  fetchRemoteMedia: mocks.fetchRemoteMedia,
}));
vi.mock("@/lib/oss/object-store", () => ({
  buildConfiguredPublicOssObjectUrl: mocks.buildConfiguredPublicOssObjectUrl,
  getPublicOssObjectInfo: mocks.getPublicOssObjectInfo,
  putPublicOssStream: mocks.putPublicOssStream,
}));

import { ensureOpenAudioCache } from "@/lib/open-api/audio-cache";

const objectKey = "echolens/open-api/audio/douyin/123/audio.m4a";

describe("open API audio cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses a fixed non-empty OSS object", async () => {
    mocks.getPublicOssObjectInfo.mockResolvedValue({ contentLength: 42 });
    mocks.buildConfiguredPublicOssObjectUrl.mockReturnValue("https://public.example/audio.m4a");

    await expect(ensureOpenAudioCache({
      durationSeconds: 60,
      mediaId: "123",
      mediaSource: "douyin",
      sources: ["https://media.example/video.mp4"],
    })).resolves.toEqual({
      durationSeconds: 60,
      url: "https://public.example/audio.m4a",
    });

    expect(mocks.fetchRemoteMedia).not.toHaveBeenCalled();
    expect(mocks.putPublicOssStream).not.toHaveBeenCalled();
  });

  it("creates one fixed object for concurrent cache misses", async () => {
    mocks.getPublicOssObjectInfo.mockResolvedValue(null);
    mocks.buildConfiguredPublicOssObjectUrl.mockReturnValue("https://public.example/audio.m4a");
    mocks.fetchRemoteMedia.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    mocks.createTranscribableAudioFileFromNode.mockResolvedValue({
      cleanup: mocks.audioCleanup,
      contentType: "audio/mp4",
      durationSeconds: 60,
      filePath: `${process.cwd()}/package.json`,
      sizeBytes: 3,
    });
    mocks.putPublicOssStream.mockResolvedValue(undefined);

    await expect(Promise.all([
      ensureOpenAudioCache({
        mediaId: "123",
        mediaSource: "douyin",
        sources: ["https://media.example/video.mp4"],
      }),
      ensureOpenAudioCache({
        mediaId: "123",
        mediaSource: "douyin",
        sources: ["https://media.example/video.mp4"],
      }),
    ])).resolves.toEqual([
      { durationSeconds: 60, url: "https://public.example/audio.m4a" },
      { durationSeconds: 60, url: "https://public.example/audio.m4a" },
    ]);

    expect(mocks.fetchRemoteMedia).toHaveBeenCalledOnce();
    expect(mocks.putPublicOssStream).toHaveBeenCalledWith(expect.objectContaining({
      cacheControl: "public, max-age=86400",
      contentType: "audio/mp4",
      objectKey,
    }));
    expect(mocks.audioCleanup).toHaveBeenCalledOnce();
  });

  it("uploads Bilibili DASH audio directly without ffmpeg", async () => {
    mocks.getPublicOssObjectInfo.mockResolvedValue(null);
    mocks.buildConfiguredPublicOssObjectUrl.mockReturnValue("https://public.example/bilibili-audio.m4a");
    mocks.fetchRemoteMedia.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-length": "3", "content-type": "audio/mp4" },
    }));
    mocks.putPublicOssStream.mockResolvedValue(undefined);

    await expect(ensureOpenAudioCache({
      durationSeconds: 60,
      mediaId: "BV1xx411c7mD",
      mediaSource: "bilibili",
      sources: ["https://bilibili.example/audio.m4s"],
    })).resolves.toEqual({
      durationSeconds: 60,
      url: "https://public.example/bilibili-audio.m4a",
    });

    expect(mocks.fetchRemoteMedia).toHaveBeenCalledWith(
      ["https://bilibili.example/audio.m4s"],
      { mediaSource: "bilibili", signal: undefined },
    );
    expect(mocks.createTranscribableAudioFileFromNode).not.toHaveBeenCalled();
    expect(mocks.putPublicOssStream).toHaveBeenCalledWith(expect.objectContaining({
      contentLength: 3,
      contentType: "audio/mp4",
      objectKey: "echolens/open-api/audio/bilibili/BV1xx411c7mD/audio.m4a",
    }));
  });
});