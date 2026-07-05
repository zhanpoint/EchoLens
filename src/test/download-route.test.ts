import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetUserRouteConcurrencyForTest } from "../lib/user-concurrency";

vi.mock("@/lib/douyin/detail", () => ({
  collectWorkMetadata: vi.fn(),
}));

vi.mock("@/lib/media/audio", () => ({
  CompletedMediaCacheRequiredError: class CompletedMediaCacheRequiredError extends Error {},
  downloadRemoteMediaToCachedFile: vi.fn(),
  prepareMediaCacheForWork: vi.fn(),
  prepareTranscribableWavAudioFromCachedMedia: vi.fn(),
}));

vi.mock("@/lib/oss/asr-audio", () => ({
  uploadAsrAudioFile: vi.fn(),
}));

vi.mock("@/lib/transcript/db", () => ({
  upsertAsrAudioCache: vi.fn(),
}));

vi.mock("@/app/api/auth/_shared", () => ({
  requireUser: vi.fn(() => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));

import { collectWorkMetadata } from "@/lib/douyin/detail";
import {
  downloadRemoteMediaToCachedFile,
  prepareTranscribableWavAudioFromCachedMedia,
} from "@/lib/media/audio";
import { uploadAsrAudioFile } from "@/lib/oss/asr-audio";
import { upsertAsrAudioCache } from "@/lib/transcript/db";
import { requireUser } from "@/app/api/auth/_shared";
import { GET } from "../app/api/douyin/download/route";

const collectWorkMetadataMock = vi.mocked(collectWorkMetadata);
const downloadRemoteMediaToCachedFileMock = vi.mocked(downloadRemoteMediaToCachedFile);
const prepareTranscribableWavAudioFromCachedMediaMock = vi.mocked(prepareTranscribableWavAudioFromCachedMedia);
const requireUserMock = vi.mocked(requireUser);
const upsertAsrAudioCacheMock = vi.mocked(upsertAsrAudioCache);
const uploadAsrAudioFileMock = vi.mocked(uploadAsrAudioFile);

async function writeTempMediaFile(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "echolens-download-test-"));
  const filePath = path.join(dir, "media.bin");
  await writeFile(filePath, content);
  return filePath;
}

describe("douyin download route", () => {
  beforeEach(() => {
    resetUserRouteConcurrencyForTest();
    vi.clearAllMocks();
    requireUserMock.mockReturnValue({ email: "test@example.com", id: "user-1", username: "test" });
  });

  it("requires authentication before reading download parameters", async () => {
    requireUserMock.mockReturnValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await GET(new Request("https://echolens.dreamlog.xyz/api/douyin/download"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(collectWorkMetadataMock).not.toHaveBeenCalled();
  });

  it("downloads a collected asset instead of returning an unavailable-resource error", async () => {
    collectWorkMetadataMock.mockResolvedValue({
      coverUrls: ["https://example.com/cover.jpg"],
    });
    downloadRemoteMediaToCachedFileMock.mockResolvedValue({
      contentType: "image/jpeg",
      filePath: await writeTempMediaFile("cover"),
    });

    const response = await GET(new Request(
      "https://echolens.dreamlog.xyz/api/douyin/download?id=7649250336875613449&kind=video&asset=cover",
      {
        headers: {
          cookie: "el_session=test",
        },
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(await response.text()).toBe("cover");
    expect(downloadRemoteMediaToCachedFileMock).toHaveBeenCalledWith(
      "user-1",
      ["https://example.com/cover.jpg"],
      {
        cacheKey: "video:7649250336875613449:cover",
      },
    );
  });

  it("returns a clear error when the selected asset is absent from metadata", async () => {
    collectWorkMetadataMock.mockResolvedValue({
      caption: "只有文案",
    });

    const response = await GET(new Request(
      "https://echolens.dreamlog.xyz/api/douyin/download?id=7649250336875613449&kind=video&asset=cover",
      {
        headers: {
          cookie: "el_session=test",
        },
      },
    ));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "没有采集到可下载资源。",
    });
    expect(downloadRemoteMediaToCachedFileMock).not.toHaveBeenCalled();
  });

  it("serves video assets from the completed media cache file", async () => {
    collectWorkMetadataMock.mockResolvedValue({
      videoUrls: ["https://example.com/video.mp4"],
    });
    downloadRemoteMediaToCachedFileMock.mockResolvedValue({
      contentType: "video/mp4",
      filePath: await writeTempMediaFile("video"),
    });

    const response = await GET(new Request(
      "https://echolens.dreamlog.xyz/api/douyin/download?id=7649250336875613449&kind=video&asset=video",
      {
        headers: {
          cookie: "el_session=test",
        },
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("5");
    expect(await response.text()).toBe("video");
    expect(downloadRemoteMediaToCachedFileMock).toHaveBeenCalledWith(
      "user-1",
      ["https://example.com/video.mp4"],
      {
        cacheKey: "video:7649250336875613449:video",
      },
    );
  });

  it("streams cached original audio and exposes the ASR OSS URL headers", async () => {
    const filePath = await writeTempMediaFile("wav");
    prepareTranscribableWavAudioFromCachedMediaMock.mockResolvedValue({
      durationSeconds: 1,
      filePath,
      sizeBytes: 3,
    });
    uploadAsrAudioFileMock.mockResolvedValue({
      objectKey: "echolens/asr/test.wav",
      signedUrl: "https://oss.example.com/echolens/asr/test.wav?OSSAccessKeyId=test&Expires=1&Signature=sig",
    });

    const response = await GET(new Request(
      "https://echolens.dreamlog.xyz/api/douyin/download?id=7649250336875613449&kind=video&asset=originalAudio",
      {
        headers: {
          cookie: "el_session=test",
        },
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("x-echolens-asr-audio-object-key")).toBe("echolens%2Fasr%2Ftest.wav");
    expect(response.headers.get("x-echolens-asr-audio-url")).toBe(
      encodeURIComponent("https://oss.example.com/echolens/asr/test.wav?OSSAccessKeyId=test&Expires=1&Signature=sig"),
    );
    expect(await response.text()).toBe("wav");
    expect(prepareTranscribableWavAudioFromCachedMediaMock).toHaveBeenCalledWith(
      "user-1",
      "video:7649250336875613449:video",
    );
    expect(collectWorkMetadataMock).not.toHaveBeenCalled();
    expect(uploadAsrAudioFileMock).toHaveBeenCalledWith({
      filePath,
      userId: "user-1",
      workKey: "video:7649250336875613449",
    });
    expect(upsertAsrAudioCacheMock).toHaveBeenCalledWith({
      durationSeconds: 1,
      objectKey: "echolens/asr/test.wav",
      userId: "user-1",
      workKey: "video:7649250336875613449",
    });
  });

  it("returns a clear message when an official ad video gateway cannot be cached", async () => {
    collectWorkMetadataMock.mockResolvedValue({
      coverUrls: ["https://example.com/cover.jpg"],
      videoUrls: ["https://aweme.snssdk.com/aweme/v1/playwm/?video_id=ad&ratio=720p&line=0"],
    });
    downloadRemoteMediaToCachedFileMock.mockRejectedValue(new Error("媒体资源下载失败：HTTP 404"));

    const response = await GET(new Request(
      "https://echolens.dreamlog.xyz/api/douyin/download?id=7651467787881303306&kind=video&asset=video",
      {
        headers: {
          cookie: "el_session=test",
        },
      },
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "官方广告视频无法缓存，请尝试其他抖音作品链接。",
    });
    expect(downloadRemoteMediaToCachedFileMock).toHaveBeenCalledWith(
      "user-1",
      ["https://aweme.snssdk.com/aweme/v1/playwm/?video_id=ad&ratio=720p&line=0"],
      {
        cacheKey: "video:7651467787881303306:video",
      },
    );
  });
});
