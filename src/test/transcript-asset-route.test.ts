import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  ensureHistoryAsset: vi.fn(),
  readHistoryUpstreamAssets: vi.fn(),
}));

vi.mock("@/app/api/auth/_shared", () => ({
  logServerError: vi.fn(),
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));
vi.mock("@/lib/transcript/assets", () => ({
  ensureHistoryAsset: mocks.ensureHistoryAsset,
  readHistoryUpstreamAssets: mocks.readHistoryUpstreamAssets,
}));

import { requireUser } from "@/app/api/auth/_shared";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";
import { GET } from "../app/api/transcript-history/[id]/assets/[kind]/route";

const asset = {
  assetKind: "cover",
  contentType: "image/jpeg",
  historyRecordId: "history-1",
  objectKey: "cover",
  sizeBytes: 3,
  updatedAt: 1,
  url: "https://oss/cover",
  urlExpiresAt: 20_000,
};

describe("transcript history single asset route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
    mocks.ensureHistoryAsset.mockResolvedValue(asset);
    mocks.readHistoryUpstreamAssets.mockResolvedValue(null);
  });

  it("requires authentication before accessing an asset", async () => {
    vi.mocked(requireUser).mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await GET(assetRequest(), routeContext("cover"));

    expect(response.status).toBe(401);
    expect(mocks.ensureHistoryAsset).not.toHaveBeenCalled();
  });

  it.each(["avatar", "cover", "video", "originalAudio", "dubbing"] as const)(
    "requests only the selected %s resource",
    async (kind) => {
      const response = await GET(assetRequest(), routeContext(kind));

      expect(response.status).toBe(200);
      expect(mocks.ensureHistoryAsset).toHaveBeenCalledTimes(1);
      expect(mocks.ensureHistoryAsset).toHaveBeenCalledWith({
        assetKind: kind,
        historyRecordId: "history-1",
        userId: "user-1",
      });
    },
  );

  it("returns every refreshed upstream locator after a force refresh", async () => {
    mocks.readHistoryUpstreamAssets.mockResolvedValueOnce({
      avatar: { ...asset, assetKind: "avatar", url: "https://origin/avatar-fresh" },
      cover: { ...asset, assetKind: "cover", url: "https://origin/cover-fresh" },
      dubbing: { ...asset, assetKind: "dubbing", contentType: "audio/mp4", url: "https://origin/dubbing-fresh" },
      video: { ...asset, assetKind: "video", contentType: "video/mp4", url: "https://origin/video-fresh" },
    });

    const response = await GET(
      new Request("https://echolens.example/api/transcript-history/history-1/assets/cover?forceRefresh=1"),
      routeContext("cover"),
    );

    expect(mocks.ensureHistoryAsset).toHaveBeenCalledWith({
      assetKind: "cover",
      forceRefresh: true,
      historyRecordId: "history-1",
      userId: "user-1",
    });
    expect(mocks.readHistoryUpstreamAssets).toHaveBeenCalledWith({
      historyRecordId: "history-1",
      userId: "user-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      refreshedAssets: {
        avatar: { url: "https://origin/avatar-fresh" },
        cover: { url: "https://origin/cover-fresh" },
        dubbing: { url: "https://origin/dubbing-fresh" },
        video: { url: "https://origin/video-fresh" },
      },
    });
  });

  it("marks only a validated original audio response as verified", async () => {
    const audioAsset = {
      ...asset,
      assetKind: "originalAudio",
      contentType: "audio/mp4",
      objectKey: "audio.m4a",
      url: "https://oss/audio.m4a",
      verifiedAt: 1,
    };
    mocks.ensureHistoryAsset.mockResolvedValueOnce(audioAsset);

    const audioResponse = await GET(assetRequest(), routeContext("originalAudio"));
    const coverResponse = await GET(assetRequest(), routeContext("cover"));

    await expect(audioResponse.json()).resolves.toMatchObject({ asset: { verified: true } });
    await expect(coverResponse.json()).resolves.not.toHaveProperty("asset.verified");
  });

  it("rejects unsupported resource kinds without preparing anything", async () => {
    const response = await GET(assetRequest(), routeContext("metadata"));

    expect(response.status).toBe(400);
    expect(mocks.ensureHistoryAsset).not.toHaveBeenCalled();
  });

  it("reports a missing resource without generating it on GET", async () => {
    mocks.ensureHistoryAsset.mockResolvedValueOnce(null);

    const response = await GET(assetRequest(), routeContext("video"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "会话不存在或资源不可用。",
    });
  });

  it("returns the unified network message when OSS retries are exhausted", async () => {
    mocks.ensureHistoryAsset.mockRejectedValueOnce(new NetworkRetryExhaustedError());

    const response = await GET(assetRequest(), routeContext("video"));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      code: NETWORK_RETRY_ERROR_CODE,
      error: NETWORK_RETRY_ERROR_MESSAGE,
    });
  });
});

function assetRequest(): Request {
  return new Request("https://echolens.example/api/transcript-history/history-1/assets/cover");
}

function routeContext(kind: string) {
  return { params: Promise.resolve({ id: "history-1", kind }) };
}