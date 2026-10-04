import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireWorkMetadata: vi.fn(),
  createOssSignedUrlWithExpiration: vi.fn(),
  prepareDouyinOriginalAudio: vi.fn(),
  ensureTemporaryMuxedVideo: vi.fn(),
  fetchRemoteMedia: vi.fn(),
  getOssObjectInfo: vi.fn(),
  leaseRelease: vi.fn(),
  readDouyinCredentialState: vi.fn(),
  readTranscriptHistoryRecord: vi.fn(),
  readUserSetting: vi.fn(),
  putOssStream: vi.fn(),
  updateTranscriptHistoryRecordMetadata: vi.fn(),
}));

vi.mock("@/lib/media/audio", () => ({ fetchRemoteMedia: mocks.fetchRemoteMedia }));

vi.mock("@/lib/douyin/asset-bundle", () => ({
  douyinOriginalAudioObjectKey: vi.fn(() => "echolens/media/video/7649250336875613449/audio.m4a"),
  prepareDouyinOriginalAudio: mocks.prepareDouyinOriginalAudio,
}));
vi.mock("@/lib/douyin/metadata-coordinator", () => ({ acquireWorkMetadata: mocks.acquireWorkMetadata }));
vi.mock("@/lib/douyin/account", () => ({ readDouyinCredentialState: mocks.readDouyinCredentialState }));
vi.mock("@/lib/user-settings", () => ({ readUserSetting: mocks.readUserSetting }));
vi.mock("@/lib/oss/object-store", () => ({
  createOssSignedUrlWithExpiration: mocks.createOssSignedUrlWithExpiration,
  getOssObjectInfo: mocks.getOssObjectInfo,
  putOssStream: mocks.putOssStream,
}));
vi.mock("@/lib/media/temporary-video-cache", () => ({
  ensureTemporaryMuxedVideo: mocks.ensureTemporaryMuxedVideo,
}));
vi.mock("@/lib/transcript/db", () => ({
  readTranscriptHistoryRecord: mocks.readTranscriptHistoryRecord,
  updateTranscriptHistoryRecordMetadata: mocks.updateTranscriptHistoryRecordMetadata,
}));

import {
  ensureHistoryAsset,
  prepareBilibiliSnapshotAsset,
} from "@/lib/transcript/assets";

const audioObjectKey = "echolens/media/video/7649250336875613449/audio.m4a";
const history = {
  avatarUrl: "https://origin/avatar",
  caption: "标题",
  coverUrl: "https://origin/cover",
  dubbingUrl: "https://origin/dubbing",
  durationSeconds: 12,
  finalUrl: "https://www.douyin.com/video/7649250336875613449",
  id: "history-1",
  mediaQuality: "lowest",
  originalAudio: audioObjectKey,
  sourceMetadataRefreshedAt: 1,
  sourceUrlsExpiresAt: Date.now() + 10 * 60_000,
  updatedAt: 1,
  videoUrl: "https://origin/video",
  workId: "7649250336875613449",
  workKey: "video:7649250336875613449",
  workKind: "video",
};
const metadata = {
  audioUrls: ["https://origin/audio"],
  authorAvatarUrls: ["https://fresh/avatar"],
  authorName: "作者",
  caption: "标题",
  coverUrls: ["https://fresh/cover"],
  dashVideoUrls: ["https://fresh/dash-video"],
  dubbingAudioUrls: ["https://fresh/dubbing"],
  durationSeconds: 12,
  videoUrls: ["https://fresh/video"],
};

function request(assetKind: "avatar" | "cover" | "video" | "originalAudio" | "dubbing" = "originalAudio") {
  return { assetKind, historyRecordId: "history-1", userId: "user-1" };
}

describe("single-record transcript resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readTranscriptHistoryRecord.mockResolvedValue(history);
    mocks.readDouyinCredentialState.mockResolvedValue({ checkedAt: null, cookie: "", status: "missing" });
    mocks.readUserSetting.mockResolvedValue(undefined);
    mocks.getOssObjectInfo.mockResolvedValue({ contentLength: 100, contentType: "audio/mp4" });
    mocks.createOssSignedUrlWithExpiration.mockReturnValue({
      expiresAt: 20_000,
      url: "https://oss.example/audio.m4a?Expires=20",
    });
    mocks.acquireWorkMetadata.mockResolvedValue({ metadata, release: mocks.leaseRelease });
    mocks.updateTranscriptHistoryRecordMetadata.mockResolvedValue({
      ...history,
      avatarUrl: metadata.authorAvatarUrls[0],
      coverUrl: metadata.coverUrls[0],
      videoUrl: metadata.videoUrls[0],
    });
    mocks.ensureTemporaryMuxedVideo.mockResolvedValue({ cacheKey: "cache", expiresAt: 30_000, sizeBytes: 300 });
  });

  it("stops before resource access when the owned history is unavailable", async () => {
    mocks.readTranscriptHistoryRecord.mockResolvedValueOnce(null);
    await expect(ensureHistoryAsset(request())).resolves.toBeNull();
    expect(mocks.getOssObjectInfo).not.toHaveBeenCalled();
  });

  it("reuses the original-audio object and signs it at use time", async () => {
    await expect(ensureHistoryAsset(request())).resolves.toMatchObject({
      objectKey: audioObjectKey,
      url: "https://oss.example/audio.m4a?Expires=20",
      urlExpiresAt: 20_000,
    });
    expect(mocks.getOssObjectInfo).toHaveBeenCalledWith(audioObjectKey);
    expect(mocks.acquireWorkMetadata).not.toHaveBeenCalled();
  });

  it("returns a fresh upstream image locator without uploading it", async () => {
    await expect(ensureHistoryAsset(request("avatar"))).resolves.toMatchObject({
      assetKind: "avatar",
      url: history.avatarUrl,
    });
    expect(mocks.acquireWorkMetadata).not.toHaveBeenCalled();
    expect(mocks.prepareDouyinOriginalAudio).not.toHaveBeenCalled();
  });

  it("returns the distinct upstream dubbing locator without rebuilding original audio", async () => {
    await expect(ensureHistoryAsset(request("dubbing"))).resolves.toMatchObject({
      assetKind: "dubbing",
      url: history.dubbingUrl,
    });
    expect(mocks.acquireWorkMetadata).not.toHaveBeenCalled();
    expect(mocks.prepareDouyinOriginalAudio).not.toHaveBeenCalled();
  });

  it("refreshes expired upstream locators in the history record", async () => {
    mocks.readTranscriptHistoryRecord.mockResolvedValueOnce({ ...history, sourceUrlsExpiresAt: 1 });
    await expect(ensureHistoryAsset(request("cover"))).resolves.toMatchObject({
      assetKind: "cover",
      url: metadata.coverUrls[0],
    });
    expect(mocks.updateTranscriptHistoryRecordMetadata).toHaveBeenCalledWith(expect.objectContaining({
      avatarUrl: metadata.authorAvatarUrls[0],
      coverUrl: metadata.coverUrls[0],
      videoUrl: metadata.videoUrls[0],
    }));
    expect(mocks.prepareDouyinOriginalAudio).not.toHaveBeenCalled();
    expect(mocks.leaseRelease).toHaveBeenCalledTimes(1);
  });

  it("force-refreshes all upstream locators after an actual load failure without an expiry", async () => {
    mocks.readTranscriptHistoryRecord.mockResolvedValueOnce({ ...history, sourceUrlsExpiresAt: undefined });
    await expect(ensureHistoryAsset({ ...request("avatar"), forceRefresh: true })).resolves.toMatchObject({
      assetKind: "avatar",
      url: metadata.authorAvatarUrls[0],
    });
    expect(mocks.acquireWorkMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.updateTranscriptHistoryRecordMetadata).toHaveBeenCalledWith(expect.objectContaining({
      avatarUrl: metadata.authorAvatarUrls[0],
      coverUrl: metadata.coverUrls[0],
      dubbingUrl: metadata.dubbingAudioUrls[0],
      videoUrl: metadata.videoUrls[0],
    }));
  });

  it("recovers the deterministic original-audio object without rebuilding it", async () => {
    mocks.readTranscriptHistoryRecord.mockResolvedValueOnce({ ...history, originalAudio: undefined });
    await expect(ensureHistoryAsset(request())).resolves.toMatchObject({
      assetKind: "originalAudio",
      objectKey: audioObjectKey,
    });
    expect(mocks.prepareDouyinOriginalAudio).not.toHaveBeenCalled();
    expect(mocks.updateTranscriptHistoryRecordMetadata).toHaveBeenCalledWith(expect.objectContaining({
      originalAudio: audioObjectKey,
    }));
  });

  it("uploads only rebuilt original audio and persists its object key", async () => {
    mocks.readTranscriptHistoryRecord.mockResolvedValueOnce({ ...history, originalAudio: undefined });
    mocks.getOssObjectInfo.mockResolvedValueOnce(null);
    mocks.prepareDouyinOriginalAudio.mockResolvedValueOnce({
      contentType: "audio/mp4",
      durationSeconds: 12,
      objectKey: audioObjectKey,
      sizeBytes: 100,
    });
    await expect(ensureHistoryAsset(request())).resolves.toMatchObject({
      assetKind: "originalAudio",
      objectKey: audioObjectKey,
    });
    expect(mocks.prepareDouyinOriginalAudio).toHaveBeenCalledWith(
      { id: history.workId, kind: "video", videoQuality: "lowest" },
      metadata,
    );
    expect(mocks.updateTranscriptHistoryRecordMetadata).toHaveBeenLastCalledWith(expect.objectContaining({
      originalAudio: audioObjectKey,
    }));
  });

  it("prefers a temporary DASH mux for video preview", async () => {
    await expect(ensureHistoryAsset(request("video"))).resolves.toMatchObject({
      assetKind: "video",
      url: "/api/media/temporary-video?historyRecordId=history-1&cacheKey=cache",
    });
    expect(mocks.ensureTemporaryMuxedVideo).toHaveBeenCalledWith({
      audioUrls: metadata.audioUrls,
      cacheIdentity: `${history.workKey}:lowest`,
      mediaSource: "douyin",
      videoUrls: metadata.dashVideoUrls,
    });
    expect(mocks.prepareDouyinOriginalAudio).not.toHaveBeenCalled();
  });

  it("uses the shared temporary mux cache for Bilibili DASH video previews", async () => {
    await expect(prepareBilibiliSnapshotAsset({
      assetKind: "video",
      historyRecordId: "history-1",
      metadata: {} as never,
      selection: {} as never,
      snapshot: {
        authorName: "作者",
        caption: "标题",
        dashAudioUrls: ["https://bilibili.example/audio"],
        dashVideoUrls: ["https://bilibili.example/video"],
        durationSeconds: 12,
        mediaQuality: "64",
        progressiveVideoUrls: [],
        refreshedAt: 1,
        source: "bilibili",
      },
      userId: "user-1",
      workId: "BV1test:2",
      workKey: "bilibili:video:BV1test:2",
    })).resolves.toMatchObject({
      assetKind: "video",
      url: "/api/media/temporary-video?historyRecordId=history-1&cacheKey=cache",
    });
    expect(mocks.ensureTemporaryMuxedVideo).toHaveBeenCalledWith({
      audioUrls: ["https://bilibili.example/audio"],
      cacheIdentity: "bilibili:video:BV1test:2:64",
      mediaSource: "bilibili",
      videoUrls: ["https://bilibili.example/video"],
    });
  });

  it("shares a Bilibili audio upload across concurrent snapshot requests", async () => {
    let uploaded = false;
    mocks.getOssObjectInfo.mockImplementation(async () => uploaded ? { contentLength: 3, contentType: "audio/mp4" } : null);
    mocks.fetchRemoteMedia.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } }));
    mocks.putOssStream.mockImplementation(async () => { uploaded = true; });
    const input = {
      assetKind: "originalAudio" as const,
      historyRecordId: "history-1",
      metadata: { durationSeconds: 12 } as never,
      selection: { audio: { id: 30280, bandwidth: 128000, urls: ["https://bilibili.example/audio"] }, video: {} as never },
      snapshot: { authorName: "作者", caption: "标题", dashAudioUrls: [], dashVideoUrls: [], durationSeconds: 12, mediaQuality: "64", progressiveVideoUrls: [], refreshedAt: 1, source: "bilibili" as const },
      userId: "user-1",
      workId: "BV1test:2",
      workKey: "bilibili:video:BV1test:2",
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => prepareBilibiliSnapshotAsset(input)));
    expect(results).toHaveLength(10);
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledOnce();
    expect(mocks.putOssStream).toHaveBeenCalledOnce();
  });

  it("falls back to the official progressive video URL when DASH muxing fails", async () => {
    mocks.ensureTemporaryMuxedVideo.mockRejectedValueOnce(new Error("mux failed"));

    await expect(ensureHistoryAsset(request("video"))).resolves.toMatchObject({
      assetKind: "video",
      url: metadata.videoUrls[0],
    });
  });

  it("uses the official progressive video URL when DASH streams are unavailable", async () => {
    mocks.acquireWorkMetadata.mockResolvedValueOnce({
      metadata: { ...metadata, audioUrls: [], dashVideoUrls: [] },
      release: mocks.leaseRelease,
    });
    mocks.readTranscriptHistoryRecord.mockResolvedValueOnce({ ...history, sourceUrlsExpiresAt: 1 });

    await expect(ensureHistoryAsset(request("video"))).resolves.toMatchObject({
      assetKind: "video",
      url: metadata.videoUrls[0],
    });
    expect(mocks.ensureTemporaryMuxedVideo).not.toHaveBeenCalled();
  });
});
