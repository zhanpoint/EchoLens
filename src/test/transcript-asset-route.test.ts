import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  ensureBilibiliHistoryVideo: vi.fn(),
  ensureHistoryAsset: vi.fn(),
}));

vi.mock("@/app/api/auth/_shared", () => ({
  logServerError: vi.fn(),
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));
vi.mock("@/lib/transcript/assets", () => ({
  ensureBilibiliHistoryVideo: mocks.ensureBilibiliHistoryVideo,
  ensureHistoryAsset: mocks.ensureHistoryAsset,
}));

import { requireUser } from "@/app/api/auth/_shared";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";
import { GET, POST } from "../app/api/transcript-history/[id]/assets/[kind]/route";

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
    mocks.ensureBilibiliHistoryVideo.mockResolvedValue({
      ...asset,
      assetKind: "video",
      contentType: "video/mp4",
      objectKey: "bilibili:BV1xx411c7mD:100:video:32:7",
      url: "https://cdn.example/32",
    });
    mocks.ensureHistoryAsset.mockResolvedValue(asset);
  });

  it("requires authentication before accessing an asset", async () => {
    vi.mocked(requireUser).mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await GET(assetRequest(), routeContext("cover"));

    expect(response.status).toBe(401);
    expect(mocks.ensureHistoryAsset).not.toHaveBeenCalled();
  });

  it.each(["avatar", "cover", "video", "originalAudio"] as const)(
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
    expect(mocks.ensureBilibiliHistoryVideo).not.toHaveBeenCalled();
  });

  it("generates a Bilibili video resource only through POST", async () => {
    const response = await POST(assetRequest(), routeContext("video"));

    expect(response.status).toBe(200);
    expect(mocks.ensureHistoryAsset).not.toHaveBeenCalled();
    expect(mocks.ensureBilibiliHistoryVideo).toHaveBeenCalledWith({
      historyRecordId: "history-1",
      userId: "user-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      asset: {
        assetKind: "video",
        objectKey: "bilibili:BV1xx411c7mD:100:video:32:7",
        url: "https://cdn.example/32",
      },
    });
  });

  it("rejects POST generation for non-video resources", async () => {
    const response = await POST(assetRequest(), routeContext("cover"));

    expect(response.status).toBe(400);
    expect(mocks.ensureBilibiliHistoryVideo).not.toHaveBeenCalled();
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