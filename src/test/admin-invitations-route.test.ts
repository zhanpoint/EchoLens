import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/auth/_shared", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/invitations/service", () => ({
  listAccountServiceInvitations: vi.fn(async () => [{
    code: "ECHO-AAAA-BBBB-CCCC",
    createdAt: 1_700_000_000_000,
    redeemedAt: null,
    redeemedBy: null,
    redeemedByUsername: null,
  }]),
}));

import { requireUser } from "@/app/api/auth/_shared";
import { GET } from "@/app/api/admin/invitations/route";
import { listAccountServiceInvitations } from "@/lib/invitations/service";

const requireUserMock = vi.mocked(requireUser);
const listInvitationsMock = vi.mocked(listAccountServiceInvitations);

describe("admin invitations route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns plaintext inventory to persisted administrators", async () => {
    requireUserMock.mockResolvedValue({
      email: "admin@example.com",
      id: "admin-1",
      role: "admin",
      username: "timesea",
    });

    const response = await GET(new Request("https://echolens.test/api/admin/invitations"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      invitations: [{ code: "ECHO-AAAA-BBBB-CCCC" }],
    });
    expect(listInvitationsMock).toHaveBeenCalledOnce();
  });

  it("rejects a normal user even if the username is timesea", async () => {
    requireUserMock.mockResolvedValue({
      email: "user@example.com",
      id: "user-1",
      role: "user",
      username: "timesea",
    });

    const response = await GET(new Request("https://echolens.test/api/admin/invitations"));

    expect(response.status).toBe(403);
    expect(listInvitationsMock).not.toHaveBeenCalled();
  });

  it("rejects anonymous requests", async () => {
    requireUserMock.mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await GET(new Request("https://echolens.test/api/admin/invitations"));

    expect(response.status).toBe(401);
    expect(listInvitationsMock).not.toHaveBeenCalled();
  });
});