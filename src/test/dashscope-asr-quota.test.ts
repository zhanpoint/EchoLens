import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/transcript/db", () => ({
  attachAsrTaskProviderTask: vi.fn(async () => true),
  markAsrTaskFailed: vi.fn(async () => true),
  markAsrTaskRunning: vi.fn(),
  markAsrTaskSucceeded: vi.fn(),
  readAsrTask: vi.fn(),
  readRunningAsrTask: vi.fn(),
  reserveAsrTask: vi.fn(async () => true),
}));

import { AsrQuotaExceededError, submitDashScopeAsrJob } from "@/lib/dashscope/asr";
import {
  attachAsrTaskProviderTask,
  markAsrTaskFailed,
  readAsrTask,
  readRunningAsrTask,
  reserveAsrTask,
} from "@/lib/transcript/db";

const attachAsrTaskProviderTaskMock = vi.mocked(attachAsrTaskProviderTask);
const markAsrTaskFailedMock = vi.mocked(markAsrTaskFailed);
const readAsrTaskMock = vi.mocked(readAsrTask);
const reserveAsrTaskMock = vi.mocked(reserveAsrTask);
const readRunningAsrTaskMock = vi.mocked(readRunningAsrTask);

describe("DashScope ASR lifetime platform quota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DASHSCOPE_API_KEY = "key";
    reserveAsrTaskMock.mockResolvedValue(true);
    readRunningAsrTaskMock.mockResolvedValue(null);
    readAsrTaskMock.mockResolvedValue(null);
    attachAsrTaskProviderTaskMock.mockResolvedValue(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ output: { task_id: "task-1" } }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("blocks new ASR submissions when successful duration would exceed 1 hour", async () => {
    reserveAsrTaskMock.mockResolvedValue(false);

    await expect(submitDashScopeAsrJob(
      "user-1",
      "video:1",
      {
        durationSeconds: 11,
        objectKey: "echolens/media/video/1/audio.m4a",
        signedUrl: "https://oss.example.com/test.m4a",
      },
      { model: "qwen3-asr-flash-filetrans", profile: "e1" },
    )).rejects.toBeInstanceOf(AsrQuotaExceededError);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reuses a running platform task without checking duration again", async () => {
    readRunningAsrTaskMock.mockResolvedValue({
      audioDurationSeconds: 60,
      cacheKey: "cache-1",
      credentialSource: "platform",
      id: "job-running",
      model: "fun-asr",
      objectKey: "echolens/media/video/1/audio.m4a",
      status: "running",
      taskId: "dashscope-task-1",
      updatedAt: Date.now(),
      userId: "user-1",
      workKey: "video:1",
    });

    await expect(submitDashScopeAsrJob(
      "user-1",
      "video:1",
      {
        durationSeconds: 5 * 60 * 60,
        objectKey: "echolens/media/video/1/audio.m4a",
        signedUrl: "https://oss.example.com/test.m4a",
      },
      { diarizationEnabled: true, model: "fun-asr", profile: "e2", speakerCount: 2 },
    )).resolves.toEqual({
      jobId: "job-running",
      status: "running",
    });

    expect(readRunningAsrTaskMock).toHaveBeenCalledWith({
      cacheKey: expect.stringMatching(/^platform:fun-asr:asr-v6:/),
      userId: "user-1",
    });
    expect(reserveAsrTaskMock).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("submits one new task using the audio-object cache key only after cache and running-task misses", async () => {
    await expect(submitDashScopeAsrJob(
      "user-1",
      "video:1",
      {
        durationSeconds: 60,
        objectKey: "echolens/media/video/1/audio.m4a",
        signedUrl: "https://oss.example.com/test.m4a",
      },
      { model: "qwen3-asr-flash-filetrans", profile: "e1" },
    )).resolves.toMatchObject({
      jobId: expect.any(String),
      status: "running",
    });

    expect(readRunningAsrTaskMock).toHaveBeenCalledWith({
      cacheKey: expect.stringMatching(/^platform:qwen3-asr-flash-filetrans:asr-v6:/),
      userId: "user-1",
    });
    expect(reserveAsrTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheKey: expect.stringMatching(/^platform:qwen3-asr-flash-filetrans:asr-v6:/),
        credentialSource: "platform",
        objectKey: "echolens/media/video/1/audio.m4a",
        userId: "user-1",
        workKey: "video:1",
      }),
      60 * 60,
    );
  });

  it("does not consume platform quota for a custom-key task", async () => {
    await submitDashScopeAsrJob(
      "user-1",
      "video:1",
      {
        ...asrAudio(),
        durationSeconds: 5 * 60 * 60,
      },
      { model: "qwen3-asr-flash-filetrans", profile: "e1" },
      { apiKey: "custom-key", credentialSource: "custom" },
    );

    expect(reserveAsrTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ credentialSource: "custom" }),
      undefined,
    );
  });

  it("retries an explicitly rejected 5xx submission and attaches only the successful task", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "temporary" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "temporary" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "temporary" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "temporary" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { task_id: "task-5" } }), { status: 200 }));

    const submission = submitDashScopeAsrJob(
      "user-1",
      "video:1",
      asrAudio(),
      { model: "qwen3-asr-flash-filetrans", profile: "e1" },
    );
    await vi.runAllTimersAsync();

    await expect(submission).resolves.toMatchObject({ status: "running" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(attachAsrTaskProviderTaskMock).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-5" }));
  });

  it("does not replay a submission when the transport result is unknown", async () => {
    const fetchMock = vi.mocked(globalThis.fetch).mockRejectedValue(new Error("fetch failed: socket timeout"));

    await expect(submitDashScopeAsrJob(
      "user-1",
      "video:1",
      asrAudio(),
      { model: "qwen3-asr-flash-filetrans", profile: "e1" },
    )).resolves.toMatchObject({
      status: "failed",
      result: {
        code: "NETWORK_RETRY_EXHAUSTED",
        detail: "网络连接失败，请检查网络后重试。",
        ok: false,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attachAsrTaskProviderTaskMock).not.toHaveBeenCalled();
    expect(markAsrTaskFailedMock).toHaveBeenCalledOnce();
  });

  it("returns an existing client task without submitting again", async () => {
    readAsrTaskMock.mockResolvedValue({
      audioDurationSeconds: 60,
      cacheKey: "cache-1",
      credentialSource: "platform",
      id: "client-job-1",
      model: "qwen3-asr-flash-filetrans",
      objectKey: "echolens/media/video/1/audio.m4a",
      status: "running",
      taskId: "provider-task-1",
      updatedAt: Date.now(),
      userId: "user-1",
      workKey: "video:1",
    });

    await expect(submitDashScopeAsrJob(
      "user-1",
      "video:1",
      asrAudio(),
      { model: "qwen3-asr-flash-filetrans", profile: "e1" },
      { clientJobId: "client-job-1" },
    )).resolves.toEqual({ jobId: "client-job-1", status: "running" });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(reserveAsrTaskMock).not.toHaveBeenCalled();
  });
});

function asrAudio() {
  return {
    durationSeconds: 60,
    objectKey: "echolens/media/video/1/audio.m4a",
    signedUrl: "https://oss.example.com/test.m4a",
  };
}
