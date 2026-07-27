import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/auth/_shared", () => ({
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));

vi.mock("@/lib/douyin/account", () => ({
  markDouyinCredentialInvalid: vi.fn(async () => undefined),
  readDouyinCredentialState: vi.fn(async () => ({
    checkedAt: 1_234,
    cookie: "sessionid=abc; ttwid=token",
    status: "valid",
  })),
}));

vi.mock("@/lib/douyin/following", () => ({
  collectDouyinFollowingUsers: vi.fn(async () => [
    {
      avatarUrl: "https://example.com/avatar.jpg",
      id: "fresh",
      name: "最新用户",
      signature: "",
      uniqueId: "fresh",
      url: "https://www.douyin.com/user/fresh",
    },
  ]),
}));

import { requireUser } from "@/app/api/auth/_shared";
import { readDouyinCredentialState } from "@/lib/douyin/account";
import { collectDouyinFollowingUsers } from "@/lib/douyin/following";
import { POST } from "@/app/api/douyin/following/route";

const requireUserMock = vi.mocked(requireUser);
const readCredentialStateMock = vi.mocked(readDouyinCredentialState);
const collectMock = vi.mocked(collectDouyinFollowingUsers);

describe("douyin following route", () => {
  beforeEach(() => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "true";
    vi.clearAllMocks();
    requireUserMock.mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
    readCredentialStateMock.mockResolvedValue({
      checkedAt: 1_234,
      cookie: "sessionid=abc; ttwid=token",
      status: "valid",
    });
  });

  afterEach(() => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "true";
  });

  it("rejects non-admin users before credential reading and collection when disabled", async () => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "false";
    const response = await POST(new Request("https://echolens.test/api/douyin/following", { method: "POST" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "DOUYIN_ACCOUNT_SERVICES_DISABLED" });
    expect(requireUserMock).toHaveBeenCalledOnce();
    expect(readCredentialStateMock).not.toHaveBeenCalled();
    expect(collectMock).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    requireUserMock.mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));
    expect((await POST(new Request("https://echolens.test/api/douyin/following", { method: "POST" }))).status).toBe(401);
  });

  it("returns a fresh snapshot without server-side persistence", async () => {
    const response = await POST(new Request("https://echolens.test/api/douyin/following", { method: "POST" }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.users[0].name).toBe("最新用户");
    expect(payload.refreshedAt).toEqual(expect.any(Number));
    expect(collectMock).toHaveBeenCalledOnce();
  });

  it("blocks synchronization when the persisted credential status is invalid", async () => {
    readCredentialStateMock.mockResolvedValue({
      checkedAt: 1_234,
      cookie: "sessionid=expired",
      status: "invalid",
    });
    const response = await POST(new Request("https://echolens.test/api/douyin/following", { method: "POST" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CREDENTIAL_INVALID" });
    expect(collectMock).not.toHaveBeenCalled();
  });
});
