import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/auth/_shared", () => ({
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));

vi.mock("@/lib/douyin/account", () => ({
  readDouyinCredentialState: vi.fn(async () => ({
    checkedAt: 1_234,
    cookie: "sessionid=abc",
    status: "valid",
  })),
}));

import { requireUser } from "@/app/api/auth/_shared";
import { readDouyinCredentialState } from "@/lib/douyin/account";
import { GET } from "@/app/api/douyin/credential/validate/route";

const requireUserMock = vi.mocked(requireUser);
const readStateMock = vi.mocked(readDouyinCredentialState);

describe("douyin credential status route", () => {
  beforeEach(() => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "true";
    vi.clearAllMocks();
    requireUserMock.mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
    readStateMock.mockResolvedValue({ checkedAt: 1_234, cookie: "sessionid=abc", status: "valid" });
  });

  afterEach(() => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "true";
  });

  it("rejects non-admin users before credential reading when disabled", async () => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "false";
    const response = await GET(new Request("https://echolens.test/api/douyin/credential/validate"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "DOUYIN_ACCOUNT_SERVICES_DISABLED" });
    expect(requireUserMock).toHaveBeenCalledOnce();
    expect(readStateMock).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    requireUserMock.mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));
    expect((await GET(new Request("https://echolens.test/api/douyin/credential/validate"))).status).toBe(401);
  });

  it("returns the persisted valid status without exposing the credential", async () => {
    const response = await GET(new Request("https://echolens.test/api/douyin/credential/validate"));
    expect(await response.json()).toEqual({
      checkedAt: 1_234,
      message: "抖音账号访问凭证状态正常。",
      status: "valid",
    });
  });

  it("returns a user-friendly missing-credential status", async () => {
    readStateMock.mockResolvedValue({ checkedAt: null, cookie: "", status: "missing" });
    const response = await GET(new Request("https://echolens.test/api/douyin/credential/validate"));
    expect(await response.json()).toMatchObject({ status: "missing" });
  });
});
