import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), control: vi.fn(), start: vi.fn() }));
vi.mock("@/app/api/auth/_shared", () => ({ requireUser: mocks.user }));
vi.mock("@/lib/batch/db", () => ({ controlBatch: mocks.control, readBatch: vi.fn() }));
vi.mock("@/lib/batch/worker", () => ({ startBatchWorker: mocks.start }));
import { PATCH } from "@/app/api/batch/[id]/route";
const itemId = "c649f7e0-7862-4d6d-843e-7a95e3fcd4be";
const request = (body: unknown) => PATCH(new Request("http://localhost/api/batch/batch-1", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "batch-1" }) });
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: "owner" }); mocks.control.mockResolvedValue(true); });
describe("batch retry requests", () => {
  it.each([undefined, itemId])("passes the authenticated owner and optional selected item to retry", async target => {
    const response = await request({ action: "retry", ...(target ? { itemId: target } : {}) });
    expect(response.status).toBe(200);
    expect(mocks.control).toHaveBeenCalledWith("owner", "batch-1", "retry", target);
    expect(mocks.start).toHaveBeenCalledOnce();
  });
  it.each([{ action: "retry", itemId: "invalid" }, { action: "pause", itemId }, { action: "resume", itemId }, { action: "cancel", itemId }])("rejects an invalid or inapplicable item target", async body => {
    expect((await request(body)).status).toBe(400);
    expect(mocks.control).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("does not start a worker for an inaccessible or nonfailed target", async () => {
    mocks.control.mockResolvedValue(false);
    expect((await request({ action: "retry", itemId })).status).toBe(404);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("preserves authentication failure without dispatching work", async () => {
    mocks.user.mockResolvedValue(Response.json({ error: "请登录" }, { status: 401 }));
    expect((await request({ action: "retry" })).status).toBe(401);
    expect(mocks.control).not.toHaveBeenCalled();
  });
});
