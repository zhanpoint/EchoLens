import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { DouyinApiError } from "@/lib/douyin/web-client";

const payload = {
  awemeId: "123",
  collectedAt: 2,
  commentCount: 1,
  comments: [],
};

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  credential: vi.fn(),
  markCredentialInvalid: vi.fn(),
  metadata: vi.fn(),
  read: vi.fn(),
  readHistory: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/app/api/auth/_shared", () => ({
  logServerError: vi.fn(),
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));
vi.mock("@/app/api/douyin/_credential", () => ({
  readValidDouyinCredential: mocks.credential,
}));
vi.mock("@/lib/douyin/account", () => ({
  markDouyinCredentialInvalid: mocks.markCredentialInvalid,
}));
vi.mock("@/lib/douyin/comments", () => ({ collectDouyinComments: mocks.collect }));
vi.mock("@/lib/transcript/comments", () => ({
  readTranscriptHistoryComments: mocks.read,
  readTranscriptHistoryCommentsMetadata: mocks.metadata,
  upsertTranscriptHistoryComments: mocks.upsert,
}));
vi.mock("@/lib/transcript/db", () => ({ readTranscriptHistoryRecord: mocks.readHistory }));

import { requireUser } from "@/app/api/auth/_shared";
import { GET, POST } from "@/app/api/transcript-history/[id]/comments/route";

const requireUserMock = vi.mocked(requireUser);

describe("transcript comment route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUserMock.mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
    mocks.readHistory.mockResolvedValue({ id: "history-1", workId: "123" });
    mocks.credential.mockResolvedValue("sessionid=test; msToken=test-token");
    mocks.metadata.mockResolvedValue({ collectedAt: 2, commentCount: 1 });
    mocks.read.mockResolvedValue(payload);
    mocks.upsert.mockResolvedValue(true);
    mocks.collect.mockImplementation(async ({ onProgress }) => {
      onProgress({ commentCount: 1, page: 1 });
      return payload;
    });
  });

  it("requires an EchoLens user", async () => {
    requireUserMock.mockResolvedValueOnce(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    const response = await GET(new Request("https://echolens.test/api/transcript-history/history-1/comments"), context());
    expect(response.status).toBe(401);
    expect(mocks.readHistory).not.toHaveBeenCalled();
  });

  it("returns metadata and a database-backed JSON download", async () => {
    const metadataResponse = await GET(
      new Request("https://echolens.test/api/transcript-history/history-1/comments?metadata=1"),
      context(),
    );
    await expect(metadataResponse.json()).resolves.toEqual({ metadata: { collectedAt: 2, commentCount: 1 } });

    const downloadResponse = await GET(
      new Request("https://echolens.test/api/transcript-history/history-1/comments?download=1"),
      context(),
    );
    expect(downloadResponse.headers.get("content-disposition")).toContain("echolens-123-comments.json");
    await expect(downloadResponse.json()).resolves.toEqual(payload);
  });

  it("returns the shared credential error when Douyin credentials are unavailable", async () => {
    mocks.credential.mockResolvedValueOnce(NextResponse.json({
      code: "CREDENTIAL_MISSING",
      error: "尚未设置抖音账号访问凭证，请先前往设置完成配置。",
    }, { status: 409 }));
    const response = await POST(
      new Request("https://echolens.test/api/transcript-history/history-1/comments", { method: "POST" }),
      context(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "CREDENTIAL_MISSING",
      error: "尚未设置抖音账号访问凭证，请先前往设置完成配置。",
    });
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("streams progress with the saved Douyin credential and persists once", async () => {
    const response = await POST(
      new Request("https://echolens.test/api/transcript-history/history-1/comments", { method: "POST" }),
      context(),
    );
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).not.toContain('"type":"started"');
    expect(body).toContain('"type":"progress"');
    expect(body).toContain('"type":"done"');
    expect(mocks.collect).toHaveBeenCalledWith(expect.objectContaining({
      awemeId: "123",
      client: expect.objectContaining({ query: expect.any(Function), request: expect.any(Function) }),
    }));
    expect(mocks.upsert).toHaveBeenCalledOnce();
    expect(mocks.upsert).toHaveBeenCalledWith({
      historyRecordId: "history-1",
      payload,
      userId: "user-1",
    });
  });

  it("marks an expired credential and asks the client to reconfigure it", async () => {
    mocks.collect.mockRejectedValueOnce(new DouyinApiError("expired", "LOGIN_REQUIRED"));
    const response = await POST(
      new Request("https://echolens.test/api/transcript-history/history-1/comments", { method: "POST" }),
      context(),
    );
    const body = await response.text();

    expect(body).toContain('"code":"CREDENTIAL_INVALID"');
    expect(mocks.markCredentialInvalid).toHaveBeenCalledWith("user-1");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not expose another user's history", async () => {
    mocks.readHistory.mockResolvedValueOnce(null);
    const response = await POST(
      new Request("https://echolens.test/api/transcript-history/history-1/comments", { method: "POST" }),
      context(),
    );
    expect(response.status).toBe(404);
    expect(mocks.collect).not.toHaveBeenCalled();
  });
});

function context() {
  return { params: Promise.resolve({ id: "history-1" }) };
}