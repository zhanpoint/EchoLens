import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { resetUserRouteConcurrencyForTest } from "../lib/user-concurrency";
import { resetUserRateLimitsForTest } from "../lib/user-rate-limit";

vi.mock("@/lib/douyin/detail", () => ({
  collectWorkMetadata: vi.fn(),
}));

vi.mock("@/lib/media/audio", () => ({
  downloadRemoteMediaToBuffer: vi.fn(),
  normalizeAudioToWav: vi.fn(),
  prepareMediaCacheForWork: vi.fn(),
}));

vi.mock("@/app/api/auth/_shared", () => ({
  requireUser: vi.fn(() => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));

import { collectWorkMetadata } from "@/lib/douyin/detail";
import { downloadRemoteMediaToBuffer } from "@/lib/media/audio";
import { requireUser } from "@/app/api/auth/_shared";
import { GET } from "../app/api/douyin/download/route";

const collectWorkMetadataMock = vi.mocked(collectWorkMetadata);
const downloadRemoteMediaToBufferMock = vi.mocked(downloadRemoteMediaToBuffer);
const requireUserMock = vi.mocked(requireUser);

describe("douyin download route", () => {
  beforeEach(() => {
    resetUserRouteConcurrencyForTest();
    resetUserRateLimitsForTest();
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
    downloadRemoteMediaToBufferMock.mockResolvedValue({
      buffer: Buffer.from("cover"),
      contentType: "image/jpeg",
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
    expect(downloadRemoteMediaToBufferMock).toHaveBeenCalledWith("user-1", ["https://example.com/cover.jpg"]);
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
    expect(downloadRemoteMediaToBufferMock).not.toHaveBeenCalled();
  });
});
