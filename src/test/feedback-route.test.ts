import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/auth/_shared", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/feedback/service", () => ({
  FEEDBACK_TYPES: ["bug", "feature", "other"],
  createUserFeedback: vi.fn(),
}));

import { POST } from "@/app/api/feedback/route";
import { requireUser } from "@/app/api/auth/_shared";
import { createUserFeedback } from "@/lib/feedback/service";

const createFeedbackMock = vi.mocked(createUserFeedback);
const requireUserMock = vi.mocked(requireUser);

describe("feedback route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores feedback under the authenticated user", async () => {
    requireUserMock.mockResolvedValue({ email: "user@example.com", id: "user-1", role: "user", username: "user" });
    createFeedbackMock.mockResolvedValue({
      content: "建议增加导出功能",
      createdAt: 1_700_000_000_000,
      id: "123e4567-e89b-12d3-a456-426614174000",
      resolvedAt: null,
      status: "open",
      type: "feature",
      userEmail: "user@example.com",
      userId: "user-1",
      username: "user",
    });

    const response = await POST(new Request("https://echolens.test/api/feedback", {
      body: JSON.stringify({ content: " 建议增加导出功能 ", type: "feature" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));

    expect(response.status).toBe(201);
    expect(createFeedbackMock).toHaveBeenCalledWith({
      content: "建议增加导出功能",
      type: "feature",
      userId: "user-1",
    });
  });

  it("rejects invalid feedback without persisting it", async () => {
    requireUserMock.mockResolvedValue({ email: "user@example.com", id: "user-1", role: "user", username: "user" });

    const response = await POST(new Request("https://echolens.test/api/feedback", {
      body: JSON.stringify({ content: "" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));

    expect(response.status).toBe(400);
    expect(createFeedbackMock).not.toHaveBeenCalled();
  });

  it("rejects anonymous submissions", async () => {
    requireUserMock.mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await POST(new Request("https://echolens.test/api/feedback", { method: "POST" }));

    expect(response.status).toBe(401);
    expect(createFeedbackMock).not.toHaveBeenCalled();
  });
});