import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetClientRouteConcurrencyForTest } from "../lib/client-concurrency";

vi.mock("@/lib/douyin/detail", () => ({
  collectWorkMetadata: vi.fn(),
}));

vi.mock("@/lib/media/audio", () => ({
  downloadRemoteMediaToBuffer: vi.fn(),
  normalizeAudioToWav: vi.fn(),
}));

import { collectWorkMetadata } from "@/lib/douyin/detail";
import { downloadRemoteMediaToBuffer } from "@/lib/media/audio";
import { GET } from "../app/api/douyin/download/route";

const collectWorkMetadataMock = vi.mocked(collectWorkMetadata);
const downloadRemoteMediaToBufferMock = vi.mocked(downloadRemoteMediaToBuffer);

describe("douyin download route", () => {
  beforeEach(() => {
    resetClientRouteConcurrencyForTest();
    vi.clearAllMocks();
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
          cookie: "el_client=test-client-000000000000",
        },
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(downloadRemoteMediaToBufferMock).toHaveBeenCalledWith(["https://example.com/cover.jpg"]);
  });

  it("returns a clear error when the selected asset is absent from metadata", async () => {
    collectWorkMetadataMock.mockResolvedValue({
      caption: "只有文案",
    });

    const response = await GET(new Request(
      "https://echolens.dreamlog.xyz/api/douyin/download?id=7649250336875613449&kind=video&asset=cover",
      {
        headers: {
          cookie: "el_client=test-client-000000000000",
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
