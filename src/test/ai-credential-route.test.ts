import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const { readUserSetting } = vi.hoisted(() => ({
  readUserSetting: vi.fn(),
}));

vi.mock("@/app/api/auth/_shared", () => ({
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));

vi.mock("@/lib/user-settings", () => ({
  readUserSetting,
}));

import { requireUser } from "@/app/api/auth/_shared";
import { GET } from "@/app/api/user/settings/ai-credential/route";

const requireUserMock = vi.mocked(requireUser);

describe("user AI credential route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUserMock.mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
    readUserSetting.mockResolvedValue({ apiKey: "sk-user-secret" });
  });

  it("requires authentication", async () => {
    requireUserMock.mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await GET(new Request("https://echolens.test/api/user/settings/ai-credential"));

    expect(response.status).toBe(401);
    expect(readUserSetting).not.toHaveBeenCalled();
  });

  it("returns only the current user's saved API key", async () => {
    const response = await GET(new Request("https://echolens.test/api/user/settings/ai-credential"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ apiKey: "sk-user-secret" });
    expect(readUserSetting).toHaveBeenCalledWith("user-1", "aiCredential");
  });

  it("returns an empty value when no custom API key is configured", async () => {
    readUserSetting.mockResolvedValue(undefined);

    const response = await GET(new Request("https://echolens.test/api/user/settings/ai-credential"));

    expect(await response.json()).toEqual({ apiKey: "" });
  });
});
