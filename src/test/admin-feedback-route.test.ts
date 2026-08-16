import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/auth/_shared", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/feedback/service", () => ({
  FEEDBACK_STATUSES: ["open", "resolved"],
  deleteUserFeedback: vi.fn(),
  listUserFeedback: vi.fn(),
  updateUserFeedbackStatus: vi.fn(),
}));

import { DELETE, GET, PATCH } from "@/app/api/admin/feedback/route";
import { requireUser } from "@/app/api/auth/_shared";
import { deleteUserFeedback, listUserFeedback, updateUserFeedbackStatus } from "@/lib/feedback/service";

const deleteFeedbackMock = vi.mocked(deleteUserFeedback);
const listFeedbackMock = vi.mocked(listUserFeedback);
const requireUserMock = vi.mocked(requireUser);
const updateFeedbackMock = vi.mocked(updateUserFeedbackStatus);
const admin = { email: "admin@example.com", id: "admin-1", role: "admin" as const, username: "admin" };

describe("admin feedback route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns feedback only to administrators", async () => {
    requireUserMock.mockResolvedValue(admin);
    listFeedbackMock.mockResolvedValue([]);

    const response = await GET(new Request("https://echolens.test/api/admin/feedback"));

    expect(response.status).toBe(200);
    expect(listFeedbackMock).toHaveBeenCalledOnce();
  });

  it("rejects a normal user", async () => {
    requireUserMock.mockResolvedValue({ email: "user@example.com", id: "user-1", role: "user", username: "user" });

    const response = await GET(new Request("https://echolens.test/api/admin/feedback"));

    expect(response.status).toBe(403);
    expect(listFeedbackMock).not.toHaveBeenCalled();
  });

  it("updates feedback status for administrators", async () => {
    requireUserMock.mockResolvedValue(admin);
    updateFeedbackMock.mockResolvedValue({
      content: "页面异常",
      createdAt: 1_700_000_000_000,
      id: "123e4567-e89b-12d3-a456-426614174000",
      resolvedAt: 1_700_000_100_000,
      status: "resolved",
      type: "bug",
      userEmail: "user@example.com",
      userId: "user-1",
      username: "user",
    });

    const response = await PATCH(new Request("https://echolens.test/api/admin/feedback", {
      body: JSON.stringify({ id: "123e4567-e89b-12d3-a456-426614174000", status: "resolved" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    }));

    expect(response.status).toBe(200);
    expect(updateFeedbackMock).toHaveBeenCalledWith("123e4567-e89b-12d3-a456-426614174000", "resolved");
  });

  it("deletes feedback for administrators", async () => {
    requireUserMock.mockResolvedValue(admin);
    deleteFeedbackMock.mockResolvedValue(true);

    const response = await DELETE(new Request("https://echolens.test/api/admin/feedback?id=123e4567-e89b-12d3-a456-426614174000", {
      method: "DELETE",
    }));

    expect(response.status).toBe(204);
    expect(deleteFeedbackMock).toHaveBeenCalledWith("123e4567-e89b-12d3-a456-426614174000");
  });

  it("rejects an invalid feedback ID when deleting", async () => {
    requireUserMock.mockResolvedValue(admin);

    const response = await DELETE(new Request("https://echolens.test/api/admin/feedback?id=invalid", {
      method: "DELETE",
    }));

    expect(response.status).toBe(400);
    expect(deleteFeedbackMock).not.toHaveBeenCalled();
  });
});