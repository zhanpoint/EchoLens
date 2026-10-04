import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { runFfmpegProcess } from "@/lib/media/ffmpeg-runner";

describe("FFmpeg process lifecycle", () => {
  let child: EventEmitter & { kill: ReturnType<typeof vi.fn>; stderr: PassThrough };
  const options = { args: ["-i", "input", "output"], binary: "ffmpeg", operation: "测试转封装", timeoutMs: 900_000 };

  beforeEach(() => {
    vi.useFakeTimers();
    child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true), stderr: new PassThrough() });
    mocks.spawn.mockReset().mockReturnValue(child);
  });

  afterEach(() => {
    child.stderr.destroy();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("adds progress output and resolves after process close", async () => {
    const task = runFfmpegProcess(options);
    expect(mocks.spawn.mock.calls[0][1]).toEqual(["-progress", "pipe:2", "-nostats", ...options.args]);
    child.emit("close", 0);
    await expect(task).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps cancellation pending until close and force-kills a process that ignores SIGTERM", async () => {
    const controller = new AbortController();
    const task = runFfmpegProcess({ ...options, signal: controller.signal });
    const result = expect(task).rejects.toMatchObject({ name: "AbortError" });
    let settled = false;
    void task.then(() => { settled = true; }, () => { settled = true; });
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    child.emit("close", null);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates a process without progress and reports the actual reason", async () => {
    const task = runFfmpegProcess(options);
    const result = expect(task).rejects.toThrow("无响应");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", 1);
    await result;
  });

  it("refreshes the idle deadline while FFmpeg produces output", async () => {
    const task = runFfmpegProcess(options);
    await vi.advanceTimersByTimeAsync(240_000);
    child.stderr.write("out_time=00:04:00.000000\n");
    await vi.advanceTimersByTimeAsync(240_000);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", 0);
    await task;
  });

  it("retains the total deadline even when progress keeps arriving", async () => {
    const task = runFfmpegProcess({ ...options, timeoutMs: 100_000 });
    const result = expect(task).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(90_000);
    child.stderr.write("out_time=00:01:30.000000\n");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", 1);
    await result;
  });

  it("does not spawn when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runFfmpegProcess({ ...options, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("preserves spawn errors and removes its timers after close", async () => {
    const task = runFfmpegProcess(options);
    const result = expect(task).rejects.toThrow("ENOENT");
    child.emit("error", new Error("ENOENT"));
    child.emit("close", -2);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
