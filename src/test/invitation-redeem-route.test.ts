import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/auth/_shared", () => ({
  errorJson: vi.fn(() => NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500 })),
  requireUser: vi.fn(),
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  enforceAuthRateLimits: vi.fn(async () => undefined),
  readClientAddress: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/invitations/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/invitations/service")>();
  return {
    ...original,
    redeemAccountServiceInvitation: vi.fn(async () => undefined),
  };
});

import { requireUser } from "@/app/api/auth/_shared";
import { enforceAuthRateLimits } from "@/lib/auth/rate-limit";
import { InvitationError, redeemAccountServiceInvitation } from "@/lib/invitations/service";
import { POST } from "@/app/api/invitations/redeem/route";

const requireUserMock = vi.mocked(requireUser);
const enforceRateLimitsMock = vi.mocked(enforceAuthRateLimits);
const redeemMock = vi.mocked(redeemAccountServiceInvitation);

describe("invitation redemption route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUserMock.mockResolvedValue({
      email: "reader@example.com",
      id: "user-1",
      role: "user",
      username: "reader",
    });
  });

  it("redeems for the authenticated user and never accepts a client user id", async () => {
    const response = await POST(createRequest({ code: "ECHO-AAAA-BBBB-CCCC", userId: "attacker-selected" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ douyinAccountServicesEnabled: true });
    expect(redeemMock).toHaveBeenCalledWith("user-1", "ECHO-AAAA-BBBB-CCCC");
    expect(enforceRateLimitsMock).toHaveBeenCalledOnce();
  });

  it("rejects blank codes before rate limiting and storage", async () => {
    const response = await POST(createRequest({ code: "" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVITATION_INVALID" });
    expect(enforceRateLimitsMock).not.toHaveBeenCalled();
    expect(redeemMock).not.toHaveBeenCalled();
  });

  it("maps a used code to conflict", async () => {
    redeemMock.mockRejectedValue(new InvitationError("邀请码已被使用。", "INVITATION_USED"));

    const response = await POST(createRequest({ code: "ECHO-AAAA-BBBB-CCCC" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "INVITATION_USED" });
  });

  it("maps an already redeemed account to conflict", async () => {
    redeemMock.mockRejectedValue(new InvitationError(
      "当前账号已核销邀请码，不能重复核销。",
      "ALREADY_REDEEMED",
    ));

    const response = await POST(createRequest({ code: "ECHO-DDDD-EEEE-FFFF" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ALREADY_REDEEMED" });
  });

  it("requires authentication", async () => {
    requireUserMock.mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await POST(createRequest({ code: "ECHO-AAAA-BBBB-CCCC" }));

    expect(response.status).toBe(401);
    expect(redeemMock).not.toHaveBeenCalled();
  });
});

function createRequest(body: Record<string, unknown>): Request {
  return new Request("https://echolens.test/api/invitations/redeem", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}