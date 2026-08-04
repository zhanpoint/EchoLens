import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireWorkMetadata: vi.fn(),
  createOssSignedUrlWithExpiration: vi.fn(),
  ensurePreparedAsset: vi.fn(),
  getOssObjectInfo: vi.fn(),
  leaseRelease: vi.fn(),
  readTranscriptHistoryAsset: vi.fn(),
  readTranscriptHistoryRecord: vi.fn(),
  readUserSetting: vi.fn(),
  upsertTranscriptHistoryAsset: vi.fn(),
}));

vi.mock("@/lib/douyin/asset-bundle", () => ({
  ensurePreparedAsset: mocks.ensurePreparedAsset,
}));
vi.mock("@/lib/douyin/metadata-coordinator", () => ({
  acquireWorkMetadata: mocks.acquireWorkMetadata,
}));
vi.mock("@/lib/user-settings", () => ({
  readUserSetting: mocks.readUserSetting,
}));
vi.mock("@/lib/oss/object-store", () => ({
  createOssSignedUrlWithExpiration: mocks.createOssSignedUrlWithExpiration,
  getOssObjectInfo: mocks.getOssObjectInfo,
}));
vi.mock("@/lib/transcript/db", () => ({
  readTranscriptHistoryAsset: mocks.readTranscriptHistoryAsset,
  readTranscriptHistoryRecord: mocks.readTranscriptHistoryRecord,
  upsertTranscriptHistoryAsset: mocks.upsertTranscriptHistoryAsset,
}));

import { ensureHistoryAsset } from "@/lib/transcript/assets";

const history = {
  finalUrl: "https://www.douyin.com/video/7649250336875613449",
  id: "history-1",
  workId: "7649250336875613449",
  workKind: "video",
};
const storedAudio = {
  assetKind: "originalAudio" as const,
  contentType: "audio/mp4",
  durationSeconds: 12,
  historyRecordId: "history-1",
  objectKey: "echolens/media/video/7649250336875613449/audio.m4a",
  sizeBytes: 100,
  updatedAt: 1,
  verifiedAt: 1,
};

function request(assetKind: "avatar" | "cover" | "video" | "originalAudio" = "originalAudio") {
  return { assetKind, historyRecordId: "history-1", userId: "user-1" };
}

describe("transcript history assets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readTranscriptHistoryRecord.mockResolvedValue(history);
    mocks.readUserSetting.mockResolvedValue(undefined);
    mocks.readTranscriptHistoryAsset.mockResolvedValue(storedAudio);
    mocks.getOssObjectInfo.mockResolvedValue({ contentLength: 100, contentType: "audio/mp4" });
    mocks.createOssSignedUrlWithExpiration.mockReturnValue({
      expiresAt: 20_000,
      url: "https://oss.example/audio.m4a?Expires=20",
    });
    mocks.acquireWorkMetadata.mockResolvedValue({ metadata: {}, release: mocks.leaseRelease });
  });

  it("stops before resource access when the owned session is unavailable", async () => {
    mocks.readTranscriptHistoryRecord.mockResolvedValueOnce(null);

    await expect(ensureHistoryAsset(request())).resolves.toBeNull();

    expect(mocks.readTranscriptHistoryRecord).toHaveBeenCalledWith({ id: "history-1", userId: "user-1" });
    expect(mocks.readTranscriptHistoryAsset).not.toHaveBeenCalled();
    expect(mocks.getOssObjectInfo).not.toHaveBeenCalled();
  });

  it("reuses an existing OSS object and signs it at use time", async () => {
    await expect(ensureHistoryAsset(request())).resolves.toMatchObject({
      objectKey: storedAudio.objectKey,
      url: "https://oss.example/audio.m4a?Expires=20",
      urlExpiresAt: 20_000,
    });

    expect(mocks.getOssObjectInfo).toHaveBeenCalledWith(storedAudio.objectKey);
    expect(mocks.createOssSignedUrlWithExpiration).toHaveBeenCalledWith(storedAudio.objectKey);
    expect(mocks.acquireWorkMetadata).not.toHaveBeenCalled();
    expect(mocks.ensurePreparedAsset).not.toHaveBeenCalled();
  });

  it("rebuilds only the requested resource when the OSS object is missing", async () => {
    const preparedCover = {
      asset: "cover" as const,
      value: { contentType: "image/jpeg", objectKey: "echolens/media/video/7649250336875613449/cover", sizeBytes: 80 },
    };
    const savedCover = { ...storedAudio, ...preparedCover.value, assetKind: "cover" as const, durationSeconds: undefined };
    mocks.readTranscriptHistoryAsset.mockResolvedValueOnce({ ...storedAudio, assetKind: "cover" });
    mocks.getOssObjectInfo.mockResolvedValueOnce(null);
    mocks.ensurePreparedAsset.mockResolvedValueOnce(preparedCover);
    mocks.upsertTranscriptHistoryAsset.mockResolvedValueOnce(savedCover);

    await expect(ensureHistoryAsset(request("cover"))).resolves.toMatchObject({
      assetKind: "cover",
      objectKey: preparedCover.value.objectKey,
    });

    expect(mocks.ensurePreparedAsset).toHaveBeenCalledWith(
      { id: history.workId, kind: "video", videoQuality: "lowest" },
      {},
      "cover",
    );
    expect(mocks.upsertTranscriptHistoryAsset).toHaveBeenCalledWith(expect.objectContaining({
      assetKind: "cover",
      historyRecordId: "history-1",
      userId: "user-1",
    }));
    expect(mocks.leaseRelease).toHaveBeenCalledTimes(1);
  });

  it("rebuilds an original audio object without persisted verification", async () => {
    const unverifiedAudio = { ...storedAudio, verifiedAt: undefined };
    const preparedAudio = {
      asset: "originalAudio" as const,
      value: { ...storedAudio, durationSeconds: 12 },
    };
    mocks.readTranscriptHistoryAsset.mockResolvedValueOnce(unverifiedAudio);
    mocks.ensurePreparedAsset.mockResolvedValueOnce(preparedAudio);
    mocks.upsertTranscriptHistoryAsset.mockResolvedValueOnce(storedAudio);

    await expect(ensureHistoryAsset(request())).resolves.toMatchObject({
      assetKind: "originalAudio",
      objectKey: storedAudio.objectKey,
    });

    expect(mocks.ensurePreparedAsset).toHaveBeenCalledWith(
      { id: history.workId, kind: "video", videoQuality: "lowest" },
      {},
      "originalAudio",
    );
    expect(mocks.upsertTranscriptHistoryAsset).toHaveBeenCalledWith(expect.objectContaining({
      assetKind: "originalAudio",
      verifiedAt: expect.any(Number),
    }));
    expect(mocks.upsertTranscriptHistoryAsset).toHaveBeenCalledTimes(1);
    expect(mocks.leaseRelease).toHaveBeenCalledTimes(1);
  });

  it("creates a fresh signed URL for every resource use", async () => {
    mocks.createOssSignedUrlWithExpiration
      .mockReturnValueOnce({ expiresAt: 20_000, url: "https://oss.example/audio.m4a?Expires=20" })
      .mockReturnValueOnce({ expiresAt: 30_000, url: "https://oss.example/audio.m4a?Expires=30" });

    const first = await ensureHistoryAsset(request());
    const second = await ensureHistoryAsset(request());

    expect(first?.url).not.toBe(second?.url);
    expect(mocks.createOssSignedUrlWithExpiration).toHaveBeenCalledTimes(2);
  });
});