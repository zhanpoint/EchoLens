import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  acquireTemporaryVideo: vi.fn(),
  readTranscriptHistoryRecord: vi.fn(),
  release: vi.fn(),
  temporaryVideoCacheKey: vi.fn(() => "expected-key"),
}));

vi.mock("@/app/api/auth/_shared", () => ({
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));
vi.mock("@/lib/media/temporary-video-cache", () => ({
  acquireTemporaryVideo: mocks.acquireTemporaryVideo,
  temporaryVideoCacheKey: mocks.temporaryVideoCacheKey,
}));
vi.mock("@/lib/transcript/db", () => ({
  readTranscriptHistoryRecord: mocks.readTranscriptHistoryRecord,
}));
vi.mock("node:fs", async () => {
  const { Readable } = await import("node:stream");
  return {
    createReadStream: vi.fn(() => Readable.from([new Uint8Array([1, 2, 3])])),
  };
});

import { requireUser } from "@/app/api/auth/_shared";
import { GET } from "@/app/api/media/temporary-video/route";

describe("temporary video route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
    mocks.readTranscriptHistoryRecord.mockResolvedValue({
      id: "history-1",
      mediaQuality: "lowest",
      workKey: "video:123",
    });
    mocks.acquireTemporaryVideo.mockResolvedValue({
      expiresAt: Date.now() + 60_000,
      filePath: "D:/tmp/video.mp4",
      release: mocks.release,
      sizeBytes: 3,
    });
  });

  it("requires authentication", async () => {
    vi.mocked(requireUser).mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));
    const response = await GET(request());
    expect(response.status).toBe(401);
  });

  it("rejects a cache key not owned by the history record", async () => {
    const response = await GET(request("other-key"));
    expect(response.status).toBe(404);
    expect(mocks.acquireTemporaryVideo).not.toHaveBeenCalled();
  });

  it("returns 410 after local cache eviction", async () => {
    mocks.acquireTemporaryVideo.mockResolvedValueOnce(null);
    const response = await GET(request());
    expect(response.status).toBe(410);
  });

  it("supports authenticated byte ranges", async () => {
    const response = await GET(request("expected-key", "bytes=1-2"));
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-2/3");
    expect(response.headers.get("content-length")).toBe("2");
    await response.arrayBuffer();
    expect(mocks.release).toHaveBeenCalled();
  });
});

function request(cacheKey = "expected-key", range?: string): Request {
  return new Request(
    `https://echolens.test/api/media/temporary-video?historyRecordId=history-1&cacheKey=${cacheKey}`,
    { headers: range ? { range } : undefined },
  );
}