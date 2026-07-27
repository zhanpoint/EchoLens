import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/service", () => ({
  readCurrentUserFromRequest: vi.fn(),
}));

import { GET } from "@/app/api/features/route";
import { readCurrentUserFromRequest } from "@/lib/auth/service";

const readCurrentUserMock = vi.mocked(readCurrentUserFromRequest);

describe("public feature status route", () => {
  beforeEach(() => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "false";
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "true";
  });

  it("reports the persisted redemption state independently", async () => {
    readCurrentUserMock.mockResolvedValue({
      douyinAccountServicesEnabled: true,
      email: "reader@example.com",
      id: "user-1",
      username: "reader",
    });

    const response = await GET(new Request("https://echolens.test/api/features"));

    expect(await response.json()).toEqual({
      douyinAccountServicesEnabled: true,
      invitationRedeemed: true,
    });
  });

  it("does not grant timesea merely by username", async () => {
    readCurrentUserMock.mockResolvedValue({
      douyinAccountServicesEnabled: false,
      email: "admin@example.com",
      id: "admin-1",
      role: "admin",
      username: "timesea",
    });

    const response = await GET(new Request("https://echolens.test/api/features"));

    expect(await response.json()).toEqual({
      douyinAccountServicesEnabled: false,
      invitationRedeemed: false,
    });
  });

  it("grants globally enabled services without exposing an invitation entry", async () => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "true";
    readCurrentUserMock.mockResolvedValue(null);

    const response = await GET(new Request("https://echolens.test/api/features"));

    expect(await response.json()).toEqual({
      douyinAccountServicesEnabled: true,
      invitationRedeemed: false,
    });
  });
});