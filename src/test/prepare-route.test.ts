import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { NetworkRetryExhaustedError } from "@/lib/http/retry";

const mocks = vi.hoisted(() => ({
  acquireWorkMetadata: vi.fn(),
  prepareDouyinSnapshotAsset: vi.fn(),
  leaseRelease: vi.fn(),
  markDouyinCredentialInvalid: vi.fn(),
  readDouyinCredentialState: vi.fn(),
  readUserSetting: vi.fn(),
  updateTranscriptHistoryRecordMetadata: vi.fn(),
}));

vi.mock("@/app/api/auth/_shared", () => ({
  logServerError: vi.fn(),
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));
vi.mock("@/lib/douyin/metadata-coordinator", () => ({ acquireWorkMetadata: mocks.acquireWorkMetadata }));
vi.mock("@/lib/douyin/account", () => ({
  markDouyinCredentialInvalid: mocks.markDouyinCredentialInvalid,
  readDouyinCredentialState: mocks.readDouyinCredentialState,
}));
vi.mock("@/lib/user-settings", () => ({ readUserSetting: mocks.readUserSetting }));
vi.mock("@/lib/transcript/assets", () => ({
  prepareDouyinSnapshotAsset: mocks.prepareDouyinSnapshotAsset,
}));
vi.mock("@/lib/transcript/db", () => ({
  updateTranscriptHistoryRecordMetadata: mocks.updateTranscriptHistoryRecordMetadata,
}));

import { requireUser } from "@/app/api/auth/_shared";
import { POST } from "../app/api/douyin/prepare/route";

const work = {
  finalUrl: "https://www.douyin.com/video/7649250336875613449",
  id: "7649250336875613449",
  kind: "video" as const,
};

const metadata = {
  audioUrls: ["https://origin/audio"],
  authorAvatarUrls: ["https://origin/avatar"],
  authorName: "作者",
  caption: "标题",
  coverUrls: ["https://origin/cover"],
  dashVideoUrls: ["https://origin/dash-video"],
  dubbingAudioUrls: ["https://origin/dubbing"],
  durationSeconds: 90,
  videoUrls: ["https://origin/video"],
};

describe("douyin prepare route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
    mocks.acquireWorkMetadata.mockResolvedValue({ metadata, release: mocks.leaseRelease });
    mocks.readDouyinCredentialState.mockResolvedValue({ checkedAt: null, cookie: "", status: "missing" });
    mocks.readUserSetting.mockResolvedValue(undefined);
    mocks.updateTranscriptHistoryRecordMetadata.mockResolvedValue({ id: "history-1", workKey: "video:7649250336875613449" });
    mocks.prepareDouyinSnapshotAsset.mockImplementation(async ({ assetKind }: { assetKind: string }) => ({
      assetKind,
      contentType: assetKind === "originalAudio" ? "audio/mp4" : assetKind === "video" ? "video/mp4" : "image/jpeg",
      durationSeconds: assetKind === "originalAudio" ? 90 : undefined,
      historyRecordId: "history-1",
      objectKey: assetKind === "originalAudio" ? "audio.m4a" : undefined,
      sizeBytes: assetKind === "originalAudio" ? 100 : 0,
      updatedAt: 1,
      url: assetKind === "originalAudio" ? "https://oss/audio.m4a" : `https://origin/${assetKind}`,
      urlExpiresAt: 20_000,
    }));
  });

  it("requires authentication before preparation", async () => {
    vi.mocked(requireUser).mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));
    const response = await POST(prepareRequest());
    expect(response.status).toBe(401);
    expect(mocks.acquireWorkMetadata).not.toHaveBeenCalled();
  });

  it("persists upstream locators and emits only original audio as an OSS object", async () => {
    const response = await POST(prepareRequest());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body.indexOf('"type":"metadata"')).toBeLessThan(body.indexOf('"type":"asset"'));
    expect(body).toContain('"asset":"avatar"');
    expect(body).toContain('"url":"https://origin/avatar"');
    expect(body).toContain('"asset":"originalAudio"');
    expect(body).toContain('"asset":"dubbing"');
    expect(body).toContain('"objectKey":"audio.m4a"');
    expect(body).toContain('"url":"https://oss/audio.m4a"');
    expect(mocks.updateTranscriptHistoryRecordMetadata).toHaveBeenCalledWith(expect.objectContaining({
      avatarUrl: metadata.authorAvatarUrls[0],
      coverUrl: metadata.coverUrls[0],
      dashVideoUrl: metadata.dashVideoUrls[0],
      dubbingUrl: metadata.dubbingAudioUrls[0],
      videoUrl: metadata.videoUrls[0],
    }));
    expect(mocks.prepareDouyinSnapshotAsset).toHaveBeenCalledTimes(5);
    expect(mocks.acquireWorkMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.leaseRelease).toHaveBeenCalledTimes(1);
  });

  it("passes the configured quality and credential into metadata acquisition", async () => {
    mocks.readUserSetting.mockResolvedValueOnce({ videoQuality: "720p" });
    mocks.readDouyinCredentialState.mockResolvedValueOnce({
      checkedAt: Date.now(), cookie: "sessionid=valid", status: "valid",
    });
    const response = await POST(prepareRequest());
    await response.text();

    expect(mocks.acquireWorkMetadata).toHaveBeenCalledWith(
      expect.objectContaining(work), "720p", undefined, "sessionid=valid",
    );
  });

  it("isolates one failed resource without discarding successful resources", async () => {
    mocks.prepareDouyinSnapshotAsset.mockImplementation(async ({ assetKind }: { assetKind: string }) => {
      if (assetKind === "avatar") throw new NetworkRetryExhaustedError();
      return {
        assetKind,
        contentType: assetKind === "originalAudio" ? "audio/mp4" : "video/mp4",
        historyRecordId: "history-1",
        objectKey: assetKind === "originalAudio" ? "audio.m4a" : undefined,
        sizeBytes: 1,
        updatedAt: 1,
        url: `https://resource/${assetKind}`,
        urlExpiresAt: 20_000,
      };
    });
    const response = await POST(prepareRequest());
    const body = await response.text();

    expect(body).toContain('"asset":"avatar"');
    expect(body).toContain('"error":"网络连接失败，请检查网络后重试。"');
    expect(body).toContain('"asset":"cover"');
    expect(body).toContain('"asset":"video"');
    expect(body).toContain('"asset":"originalAudio"');
    expect(body).toContain('"type":"done"');
  });
});

function prepareRequest(): Request {
  return new Request("https://echolens.example/api/douyin/prepare", {
    body: JSON.stringify({ ...work, historyRecordId: "history-1" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}