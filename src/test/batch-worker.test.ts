import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ claim: vi.fn(), finish: vi.fn(), transcribe: vi.fn() }));
vi.mock("@/lib/batch/db", () => ({
  claimBatchItem: mocks.claim, finishItem: mocks.finish, renewBatchLease: vi.fn(),
  recoverBatchQueue: vi.fn(async () => undefined),
  LeaseLostError: class extends Error {},
}));
vi.mock("@/lib/batch/transcribe", () => ({
  transcribeBatchItem: mocks.transcribe,
  BatchBlockedError: class extends Error {},
}));
import { startBatchWorker } from "@/lib/batch/worker";
import { DouyinApiError } from "@/lib/douyin/web-client";
type WorkerGlobals = typeof globalThis & { __echolensBatchWorker?: { active: number; ticking: boolean; timer: ReturnType<typeof setInterval> | number } };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubEnv("POSTGRES_PASSWORD", "test");
  mocks.claim.mockResolvedValue(null);
  mocks.finish.mockResolvedValue(undefined);
});
afterEach(() => {
  const globals = globalThis as WorkerGlobals;
  clearInterval(globals.__echolensBatchWorker?.timer);
  delete globals.__echolensBatchWorker;
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
});
describe("batch worker upstream recovery", () => {
  it("settles skipped work and immediately dispatches the next video", async () => {
    vi.stubEnv("BATCH_TRANSCRIBE_CONCURRENCY", "1");
    mocks.claim.mockResolvedValueOnce({ id: "silent" }).mockResolvedValueOnce({ id: "speech" });
    mocks.transcribe.mockResolvedValueOnce({ skipped: "无可识别语音" }).mockResolvedValueOnce("有效结果");
    startBatchWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.finish).toHaveBeenCalledWith({ id: "silent" }, { skipped: "无可识别语音" });
    expect(mocks.finish).toHaveBeenCalledWith({ id: "speech" }, { text: "有效结果" });
  });
  it("retires stale singleton callbacks and keeps in-flight concurrency during reload", async () => {
    vi.stubEnv("BATCH_TRANSCRIBE_CONCURRENCY", "1");
    const staleTick = vi.fn();
    const state: NonNullable<WorkerGlobals["__echolensBatchWorker"]> = { active: 1, ticking: false, timer: setInterval(staleTick, 2000) };
    (globalThis as WorkerGlobals).__echolensBatchWorker = state;
    startBatchWorker();
    await vi.advanceTimersByTimeAsync(2000);
    expect(staleTick).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect((globalThis as WorkerGlobals).__echolensBatchWorker).toBe(state);
    state.active = 0;
    mocks.claim.mockResolvedValueOnce({ id: "fresh" });
    mocks.transcribe.mockResolvedValueOnce("新模型配置的结果");
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.transcribe).toHaveBeenCalledOnce();
    expect(mocks.finish).toHaveBeenCalledWith({ id: "fresh" }, { text: "新模型配置的结果" });
  });

  it("does not duplicate dispatch when a worker starts repeatedly", async () => {
    vi.stubEnv("BATCH_TRANSCRIBE_CONCURRENCY", "1");
    const item = { id: "active" };
    mocks.claim.mockResolvedValueOnce(item);
    let complete!: (text: string) => void;
    mocks.transcribe.mockImplementationOnce(() => new Promise<string>(resolve => { complete = resolve; }));
    startBatchWorker();
    await vi.advanceTimersByTimeAsync(0);
    startBatchWorker();
    await vi.advanceTimersByTimeAsync(4000);
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.transcribe).toHaveBeenCalledOnce();
    complete("完成");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.finish).toHaveBeenCalledWith(item, { text: "完成" });
  });

  it.each(["ANTI_BOT", "BROWSER_SESSION_UNAVAILABLE"] as const)("pauses %s without progressing through the remaining videos", async code => {
    const item = { id: "active" };
    mocks.claim.mockResolvedValueOnce(item);
    mocks.transcribe.mockRejectedValueOnce(new DouyinApiError("稍后继续", code));
    startBatchWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.finish).toHaveBeenCalledWith(item, { error: "稍后继续", retry: false, pause: true });
  });
  it("keeps individual business failures distinct from a platform-wide pause", async () => {
    const item = { id: "active" };
    mocks.claim.mockResolvedValueOnce(item);
    mocks.transcribe.mockRejectedValueOnce(new DouyinApiError("作品不可用", "UPSTREAM_ERROR"));
    startBatchWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.finish).toHaveBeenCalledWith(item, { error: "作品不可用", retry: true, pause: false, retryAfterMs: undefined });
  });
  it("backs off a rate-limited platform without permanently failing the video", async () => {
    const item = { id: "limited" };
    mocks.claim.mockResolvedValueOnce(item);
    mocks.transcribe.mockRejectedValueOnce(new DouyinApiError("限流", "RATE_LIMITED", { retryAfterSeconds: 120 }));
    startBatchWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.finish).toHaveBeenCalledWith(item, { error: "限流", retry: true, pause: false, retryAfterMs: 120000 });
  });
  it("immediately prepares the next video while an accepted cloud task waits", async () => {
    vi.stubEnv("BATCH_TRANSCRIBE_CONCURRENCY", "1");
    mocks.claim.mockResolvedValueOnce({ id: "first" }).mockResolvedValueOnce({ id: "second" });
    mocks.transcribe.mockResolvedValueOnce({ pending: true }).mockResolvedValueOnce("完成");
    startBatchWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.finish).toHaveBeenCalledWith({ id: "first" }, { pending: true });
    expect(mocks.finish).toHaveBeenCalledWith({ id: "second" }, { text: "完成" });
    expect(mocks.claim).toHaveBeenCalledWith(2);
  });
});
