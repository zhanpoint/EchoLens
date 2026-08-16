import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/auth/_shared", () => ({
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));

vi.mock("@/lib/douyin/url", () => {
  class DouyinResolveError extends Error {
    constructor(message: string, readonly code: string) {
      super(message);
    }
  }

  return {
    DouyinResolveError,
    extractFirstUrl: vi.fn(() => "https://v.douyin.com/abc/"),
    resolveDouyinUrl: vi.fn(),
  };
});

vi.mock("@/lib/douyin/metadata-coordinator", () => ({
  acquireWorkMetadata: vi.fn(),
}));

vi.mock("@/lib/douyin/account", () => ({
  markDouyinCredentialInvalid: vi.fn(),
  readDouyinCredentialState: vi.fn(async () => ({ checkedAt: null, cookie: "", status: "missing" })),
}));

vi.mock("@/lib/transcript/db", () => ({
  findOrCreateTranscriptHistoryRecord: vi.fn(async (input: Record<string, unknown>) => ({
    created: true,
    record: {
      ...input,
      createdAt: 1,
      sessionName: input.sessionName ?? input.caption,
      updatedAt: 1,
    },
  })),
}));

import { requireUser } from "@/app/api/auth/_shared";
import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";
import { resolveDouyinUrl } from "@/lib/douyin/url";
import { NetworkRetryExhaustedError } from "@/lib/http/retry";
import { findOrCreateTranscriptHistoryRecord } from "@/lib/transcript/db";
import { POST } from "../app/api/media/resolve/route";

const acquireWorkMetadataMock = vi.mocked(acquireWorkMetadata);
const requireUserMock = vi.mocked(requireUser);
const findOrCreateTranscriptHistoryRecordMock = vi.mocked(findOrCreateTranscriptHistoryRecord);
const resolveDouyinUrlMock = vi.mocked(resolveDouyinUrl);

describe("media resolve route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUserMock.mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
    acquireWorkMetadataMock.mockResolvedValue({
      metadata: {
        authorAvatarUrls: ["https://example.com/avatar.jpg"],
        authorName: "测试作者",
        caption: "测试作品标题",
        coverUrls: ["https://example.com/cover.jpg"],
        durationSeconds: 60,
        videoUrls: ["https://example.com/video.mp4"],
      },
      release: vi.fn(),
    });
    findOrCreateTranscriptHistoryRecordMock.mockImplementation(async (input) => ({
      created: true,
      record: {
        ...input,
        createdAt: 1,
        sessionName: input.sessionName ?? input.caption,
        updatedAt: 1,
      },
    }));
  });

  it("returns the detected work only after its title is available", async () => {
    resolveDouyinUrlMock.mockResolvedValue({
      inputUrl: "https://v.douyin.com/abc/",
      finalUrl: "https://www.douyin.com/video/7649250336875613449",
      kind: "video",
      id: "7649250336875613449",
    });
    const response = await POST(resolveRequest("https://v.douyin.com/abc/"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      historyRecord: { id: "history-1", transcriptContent: "" },
      work: {
        caption: "测试作品标题",
        id: "7649250336875613449",
        kind: "video",
      },
    });
    expect(findOrCreateTranscriptHistoryRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      caption: "测试作品标题",
      id: "history-1",
      transcriptContent: "",
      userId: "user-1",
      workKey: "video:7649250336875613449",
    }));
  });

  it("returns a structured network error when title acquisition exhausts retries", async () => {
    resolveDouyinUrlMock.mockResolvedValue({
      inputUrl: "https://v.douyin.com/abc/",
      finalUrl: "https://www.douyin.com/video/7649250336875613449",
      kind: "video",
      id: "7649250336875613449",
    });
    acquireWorkMetadataMock.mockRejectedValueOnce(new NetworkRetryExhaustedError());

    const response = await POST(resolveRequest("https://v.douyin.com/abc/"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "NETWORK_RETRY_EXHAUSTED",
      error: "网络连接失败，请检查网络后重试。",
    });
    expect(findOrCreateTranscriptHistoryRecordMock).not.toHaveBeenCalled();
  });

  it("requires authentication before resolving the link", async () => {
    requireUserMock.mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await POST(resolveRequest("https://v.douyin.com/abc/"));

    expect(response.status).toBe(401);
    expect(resolveDouyinUrlMock).not.toHaveBeenCalled();
  });

  it("does not persist when the resolved final URL matches the current work", async () => {
    const finalUrl = "https://www.douyin.com/video/7649250336875613449";
    resolveDouyinUrlMock.mockResolvedValue({
      finalUrl,
      id: "7649250336875613449",
      inputUrl: "https://v.douyin.com/another-share-code/",
      kind: "video",
    });
    const response = await POST(resolveRequest("https://v.douyin.com/another-share-code/", finalUrl));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sameAsCurrent: true });
    expect(findOrCreateTranscriptHistoryRecordMock).not.toHaveBeenCalled();
  });

  it("reuses the user-owned session by stable work key even when final URLs differ", async () => {
    resolveDouyinUrlMock.mockResolvedValue({
      finalUrl: "https://www.douyin.com/video/7649250336875613449?from=new-share",
      id: "7649250336875613449",
      inputUrl: "https://v.douyin.com/new-share-code/",
      kind: "video",
    });
    findOrCreateTranscriptHistoryRecordMock.mockResolvedValue({
      created: false,
      record: {
        authorName: "历史作者",
        caption: "已识别作品",
        createdAt: 1,
        sessionName: "已识别作品",
        durationSeconds: 42,
        finalUrl: "https://www.douyin.com/video/7649250336875613449",
        id: "old-history",
        inputUrl: "https://v.douyin.com/old-share-code/",
        transcriptContent: "历史转录正文",
        updatedAt: 1,
        userId: "user-1",
        workId: "7649250336875613449",
        workKey: "video:7649250336875613449",
        workKind: "video",
      },
    });

    const response = await POST(resolveRequest("https://v.douyin.com/new-share-code/"));

    expect(response.status).toBe(200);
    expect(findOrCreateTranscriptHistoryRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      workKey: "video:7649250336875613449",
    }));
    await expect(response.json()).resolves.toMatchObject({
      historyRecord: { id: "old-history", transcriptContent: "历史转录正文" },
      reusedExistingSession: true,
      work: {
        caption: "测试作品标题",
        finalUrl: "https://www.douyin.com/video/7649250336875613449?from=new-share",
        id: "7649250336875613449",
      },
    });
  });
});

function resolveRequest(input: string, currentFinalUrl?: string): Request {
  return new Request("https://echolens.dreamlog.xyz/api/douyin/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentFinalUrl, historyRecordId: "history-1", input }),
  });
}
