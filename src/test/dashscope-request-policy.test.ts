import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashScopeRequestPolicy } from "@/lib/dashscope/request-policy";

afterEach(() => vi.useRealTimers());
describe("DashScope model and query pacing", () => {
  it("spaces starts per model while allowing independent models to proceed", async () => {
    vi.useFakeTimers();
    const policy = createDashScopeRequestPolicy();
    const starts: number[] = [];
    const start = Date.now();
    const tasks = Array.from({ length: 4 }, () => policy.beforeRequest("flash").then(() => starts.push(Date.now() - start)));
    await policy.beforeRequest("filetrans");
    await vi.advanceTimersByTimeAsync(299);
    expect(starts).toEqual([0, 100, 200]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(tasks);
    expect(starts).toEqual([0, 100, 200, 300]);
  });
  it("limits query starts to 20 QPS without an aborted caller consuming a slot", async () => {
    vi.useFakeTimers();
    const policy = createDashScopeRequestPolicy();
    await policy.beforeRequest("query");
    const controller = new AbortController();
    const canceled = policy.beforeRequest("query", controller.signal);
    const rejection = expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    const next = vi.fn();
    const task = policy.beforeRequest("query").then(next);
    await vi.advanceTimersByTimeAsync(49);
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await task;
    await rejection;
    expect(next).toHaveBeenCalledOnce();
  });
});
