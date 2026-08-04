import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  acquireWorkMetadata: vi.fn(),
  leaseRelease: vi.fn(),
  prepareAssetBundle: vi.fn(),
  readReusableHistoryAsset: vi.fn(),
  readUserSetting: vi.fn(),
  savePreparedHistoryAsset: vi.fn(),
  updateTranscriptHistoryRecordMetadata: vi.fn(),
}));

vi.mock("@/app/api/auth/_shared", () => ({
  logServerError: vi.fn(),
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));
vi.mock("@/lib/douyin/metadata-coordinator", () => ({
  acquireWorkMetadata: mocks.acquireWorkMetadata,
}));
vi.mock("@/lib/douyin/asset-bundle", () => ({
  assetUrl: vi.fn((asset: { objectKey: string }) => `https://oss/${asset.objectKey}`),
  prepareAssetBundle: mocks.prepareAssetBundle,
}));
vi.mock("@/lib/user-settings", () => ({
  readUserSetting: mocks.readUserSetting,
}));
vi.mock("@/lib/transcript/assets", () => ({
  readReusableHistoryAsset: mocks.readReusableHistoryAsset,
  savePreparedHistoryAsset: mocks.savePreparedHistoryAsset,
}));
vi.mock("@/lib/transcript/db", () => ({
  updateTranscriptHistoryRecordMetadata: mocks.updateTranscriptHistoryRecordMetadata,
}));

import { requireUser } from "@/app/api/auth/_shared";
import { NetworkRetryExhaustedError } from "@/lib/http/retry";
import { POST } from "../app/api/douyin/prepare/route";

const work = {
  finalUrl: "https://www.douyin.com/video/7649250336875613449",
  id: "7649250336875613449",
  kind: "video" as const,
};

function prepared(asset: "avatar" | "cover" | "video", contentType: string) {
  return Promise.resolve({
    asset,
    value: { contentType, objectKey: asset, sizeBytes: 3 },
  });
}

describe("douyin prepare route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
    mocks.acquireWorkMetadata.mockResolvedValue({
      metadata: {
        authorAvatarUrls: ["https://origin/avatar"],
        authorName: "作者",
        caption: "标题",
        coverUrls: ["https://origin/cover"],
        durationSeconds: 90,
        videoUrls: ["https://origin/video"],
      },
      release: mocks.leaseRelease,
    });
    mocks.savePreparedHistoryAsset.mockImplementation(async ({ prepared: asset }) => asset.value);
    mocks.readReusableHistoryAsset.mockResolvedValue(null);
    mocks.readUserSetting.mockResolvedValue(undefined);
    mocks.updateTranscriptHistoryRecordMetadata.mockResolvedValue({ id: "history-1" });
    mocks.prepareAssetBundle.mockReturnValue({
      assets: {
        avatar: prepared("avatar", "image/jpeg"),
        cover: prepared("cover", "image/jpeg"),
        video: prepared("video", "video/mp4"),
        originalAudio: Promise.resolve({
          asset: "originalAudio",
          value: {
            contentType: "audio/mp4",
            durationSeconds: 90,
            objectKey: "audio.m4a",
            sizeBytes: 2,
          },
        }),
      },
      completed: Promise.resolve(),
    });
  });

  it("requires authentication before starting preparation", async () => {
    vi.mocked(requireUser).mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await POST(prepareRequest());

    expect(response.status).toBe(401);
    expect(mocks.acquireWorkMetadata).not.toHaveBeenCalled();
  });

  it("emits metadata before independently completed assets", async () => {
    const response = await POST(prepareRequest());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body.indexOf('"type":"metadata"')).toBeLessThan(body.indexOf('"type":"asset"'));
    expect(body).toContain('"asset":"originalAudio"');
    expect(body).toContain('"objectKey":"audio.m4a"');
    expect(body).toContain('"url":"https://oss/audio.m4a"');
    expect(body).toContain('"verified":true');
    expect(mocks.updateTranscriptHistoryRecordMetadata).toHaveBeenCalledWith(expect.objectContaining({
      caption: "标题",
      historyRecordId: "history-1",
      userId: "user-1",
    }));
    expect(mocks.savePreparedHistoryAsset).toHaveBeenCalledWith(expect.objectContaining({
      historyRecordId: "history-1",
      prepared: expect.objectContaining({ asset: "originalAudio" }),
      userId: "user-1",
    }));
    expect(mocks.leaseRelease).toHaveBeenCalledTimes(1);
    expect(mocks.acquireWorkMetadata).toHaveBeenCalledWith(expect.objectContaining(work), "lowest");
    expect(mocks.prepareAssetBundle).toHaveBeenCalledWith(
      expect.objectContaining({ videoQuality: "lowest" }),
      expect.any(Object),
      undefined,
    );
  });

  it("uses the persisted direct-video quality for metadata and cache isolation", async () => {
    mocks.readUserSetting.mockResolvedValueOnce({ videoQuality: "720p" });

    const response = await POST(prepareRequest());
    await response.text();

    expect(mocks.acquireWorkMetadata).toHaveBeenCalledWith(expect.objectContaining(work), "720p");
    expect(mocks.prepareAssetBundle).toHaveBeenCalledWith(
      expect.objectContaining({ videoQuality: "720p" }),
      expect.any(Object),
      undefined,
    );
  });

  it("passes a persisted verified audio asset to preparation without rebuilding it", async () => {
    mocks.readReusableHistoryAsset.mockResolvedValueOnce({
      assetKind: "originalAudio",
      contentType: "audio/mp4",
      durationSeconds: 90,
      historyRecordId: "history-1",
      objectKey: "audio.m4a",
      sizeBytes: 2,
      updatedAt: 1,
      verifiedAt: 1,
    });

    const response = await POST(prepareRequest());
    await response.text();

    expect(mocks.prepareAssetBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        ...work,
        historyRecordId: "history-1",
      }),
      expect.any(Object),
      {
        originalAudio: {
          contentType: "audio/mp4",
          durationSeconds: 90,
          objectKey: "audio.m4a",
          sizeBytes: 2,
        },
      },
    );
  });

  it("keeps other assets successful when one OSS upload exhausts retries", async () => {
    mocks.prepareAssetBundle.mockReturnValueOnce({
      assets: {
        avatar: Promise.reject(new NetworkRetryExhaustedError()),
        cover: prepared("cover", "image/jpeg"),
        video: prepared("video", "video/mp4"),
        originalAudio: Promise.resolve({
          asset: "originalAudio",
          value: {
            contentType: "audio/mp4",
            durationSeconds: 90,
            objectKey: "audio.m4a",
            sizeBytes: 2,
          },
        }),
      },
      completed: Promise.resolve(),
    });

    const response = await POST(prepareRequest());
    const body = await response.text();

    expect(body).toContain('"type":"asset-error"');
    expect(body).toContain('"asset":"avatar"');
    expect(body).toContain('"error":"网络连接失败，请检查网络后重试。"');
    expect(body).toContain('"asset":"cover"');
    expect(body).toContain('"asset":"video"');
    expect(body).toContain('"asset":"originalAudio"');
    expect(body).toContain('"type":"done"');
    expect(mocks.savePreparedHistoryAsset).toHaveBeenCalledTimes(3);
    expect(mocks.leaseRelease).toHaveBeenCalledTimes(1);
  });
});

function prepareRequest(): Request {
  return new Request("https://echolens.example/api/douyin/prepare", {
    body: JSON.stringify({ ...work, historyRecordId: "history-1" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}