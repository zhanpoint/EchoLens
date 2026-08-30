import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/auth/_shared", () => ({
  logServerError: vi.fn(),
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));

vi.mock("@/lib/oss/object-store", () => ({
  createOssSignedUrl: vi.fn(() => "https://oss.example.com/server-signed-audio.m4a"),
}));

vi.mock("@/lib/transcript/assets", () => ({
  ensureHistoryAsset: vi.fn(async () => ({
    assetKind: "originalAudio",
    contentType: "audio/mp4",
    durationSeconds: 12,
    historyRecordId: "history-1",
    objectKey: "echolens/media/video/7649250336875613449/audio.m4a",
    sizeBytes: 100,
    updatedAt: Date.now(),
    url: "https://oss.example.com/server-signed-audio.m4a",
    urlExpiresAt: Date.now() + 60_000,
  })),
}));

vi.mock("@/lib/dashscope/asr", () => ({
  cancelDashScopeAsrJob: vi.fn(),
  AsrQuotaExceededError: class AsrQuotaExceededError extends Error {
    constructor() {
      super("平台转录剩余额度不足，无法转录当前音频。请前往设置，配置正确且可用的自定义 API Key 后继续使用。");
    }
  },
  getDashScopeAsrModelForProfile: vi.fn((profile: "e1" | "e2", models: { asrE1: string; asrE2: string }) =>
    profile === "e1" ? models.asrE1 : models.asrE2,
  ),
  refreshDashScopeAsrJob: vi.fn(),
  refreshDashScopeAsrJobWithOptions: vi.fn(),
  transcribeDashScopeAsr: vi.fn(),
}));

vi.mock("@/lib/dashscope/user-credential", () => ({
  readDashScopeUserConfig: vi.fn(async () => ({
    apiKey: "test-user-key",
    customApiKey: "test-user-key",
    customModels: {
      asrE1: "qwen3-asr-flash-filetrans",
      asrE2: "fun-asr",
      translation: "qwen-mt-flash",
      transcriptPostprocess: "deepseek-v4-flash",
      summary: "deepseek-v4-flash",
    },
    isCustomApiKey: true,
    models: {
      asrE1: "qwen3-asr-flash-filetrans",
      asrE2: "fun-asr",
      translation: "qwen-mt-flash",
      transcriptPostprocess: "deepseek-v4-flash",
      summary: "deepseek-v4-flash",
    },
    platformApiKey: "platform-key",
    platformModels: {
      asrE1: "qwen3-asr-flash-filetrans",
      asrE2: "fun-asr",
      translation: "qwen-mt-flash",
      transcriptPostprocess: "deepseek-v4-flash",
      summary: "deepseek-v4-flash",
    },
  })),
}));

vi.mock("@/lib/transcript/db", () => ({
  deleteAsrTask: vi.fn(async () => true),
  readTranscriptHistoryRecord: vi.fn(async () => ({
    authorName: "作者",
    authorUrl: "https://www.douyin.com/user/test",
    caption: "测试作品",
    durationSeconds: 12,
    finalUrl: "https://www.douyin.com/video/7649250336875613449",
    id: "history-1",
    inputUrl: "https://v.douyin.com/abc/",
    workId: "7649250336875613449",
    workKey: "video:7649250336875613449",
    workKind: "video",
  })),
  upsertTranscriptHistoryRecord: vi.fn(async (input: { id: string; transcriptContent: string }) => ({
    createdAt: Date.now(),
    sessionName: "测试作品",
    finalUrl: "https://www.douyin.com/video/7649250336875613449",
    id: input.id,
    inputUrl: "https://v.douyin.com/abc/",
    transcriptContent: input.transcriptContent,
    updatedAt: Date.now(),
    workId: "7649250336875613449",
    workKey: "video:7649250336875613449",
    workKind: "video",
  })),
}));

import { requireUser } from "@/app/api/auth/_shared";
import {
  cancelDashScopeAsrJob,
  AsrQuotaExceededError,
  refreshDashScopeAsrJobWithOptions,
  transcribeDashScopeAsr,
} from "@/lib/dashscope/asr";
import { readTranscriptHistoryRecord, upsertTranscriptHistoryRecord } from "@/lib/transcript/db";
import type { TranscribeWorkPayload } from "@/lib/douyin/transcribe-request";
import { DELETE, GET, POST } from "../app/api/douyin/transcribe/route";

const cancelDashScopeAsrJobMock = vi.mocked(cancelDashScopeAsrJob);
const readTranscriptHistoryRecordMock = vi.mocked(readTranscriptHistoryRecord);
const upsertTranscriptHistoryRecordMock = vi.mocked(upsertTranscriptHistoryRecord);
const requireUserMock = vi.mocked(requireUser);
const refreshDashScopeAsrJobWithOptionsMock = vi.mocked(refreshDashScopeAsrJobWithOptions);
const transcribeDashScopeAsrMock = vi.mocked(transcribeDashScopeAsr);

describe("douyin transcribe route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transcribeDashScopeAsrMock.mockResolvedValue({
      historyContext: historyContext(),
      result: {
        content: "转录文本",
        ok: true,
        transcriptSegments: [{ endSeconds: 2, startSeconds: 0, text: "转录文本" }],
      },
      status: "successed",
    });
    refreshDashScopeAsrJobWithOptionsMock.mockResolvedValue({
      historyContext: historyContext("history-polled"),
      result: {
        content: "轮询转录文本",
        ok: true,
        transcriptSegments: [{ endSeconds: 2, startSeconds: 0, text: "轮询转录文本" }],
      },
      status: "successed",
    });
    requireUserMock.mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
    cancelDashScopeAsrJobMock.mockResolvedValue(true);
  });

  it("does not expose internal request validation details", async () => {
    const response = await POST(transcribeRequest({
      unexpectedField: true,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "转录失败，请稍后重试。",
    });
  });

  it("returns the final transcript once the ASR service settles", async () => {
    const response = await POST(transcribeRequest());

    expect(response.status).toBe(200);
    const events = await readSseEvents(response);
    expect(transcribeDashScopeAsrMock).toHaveBeenCalledWith(
      "user-1",
      "video:7649250336875613449",
      {
        durationSeconds: 12,
        objectKey: "echolens/media/video/7649250336875613449/audio.m4a",
        signedUrl: "https://oss.example.com/server-signed-audio.m4a",
      },
      { model: "fun-asr", profile: "e3" },
      {
        apiKey: "test-user-key",
        clientJobId: "client-job-1",
        credentialSource: "custom",
        historyContext: historyContext(),
        postprocess: {
          model: "deepseek-v4-flash",
          onStart: expect.any(Function),
        },
        signal: expect.any(AbortSignal),
      },
    );
    expect(upsertTranscriptHistoryRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      id: "history-1",
      transcriptContent: "转录文本",
      workKey: "video:7649250336875613449",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      historyRecord: expect.objectContaining({ id: "history-1" }),
      type: "done",
      results: [
        expect.objectContaining({
          content: "转录文本",
          feature: "audioTranscript",
          label: "转录文本",
          source: "dashscope",
          status: "success",
        }),
      ],
      status: "successed",
      work: expect.any(Object),
    }));
  });

  it("passes Fun-ASR enhancement options", async () => {
    const response = await POST(transcribeRequest({
      diarizationEnabled: true,
      model: "e2",
      speakerCount: 1,
    }));

    expect(response.status).toBe(200);
    expect(transcribeDashScopeAsrMock).toHaveBeenCalledWith(
      "user-1",
      "video:7649250336875613449",
      expect.any(Object),
      { diarizationEnabled: true, model: "fun-asr", profile: "e2", speakerCount: 1 },
      {
        apiKey: "test-user-key",
        clientJobId: "client-job-1",
        credentialSource: "custom",
        historyContext: historyContext(),
        postprocess: {
          model: "deepseek-v4-flash",
          onStart: expect.any(Function),
        },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("falls back to the platform key when the custom-key submission is unavailable", async () => {
    transcribeDashScopeAsrMock
      .mockResolvedValueOnce({
        fallbackEligible: true,
        result: { code: "not_configured", detail: "custom unavailable", ok: false },
        status: "failed",
      })
      .mockResolvedValueOnce({
        historyContext: historyContext(),
        result: { content: "平台转录文本", ok: true },
        status: "successed",
      });

    const response = await POST(transcribeRequest());

    expect(response.status).toBe(200);
    expect(transcribeDashScopeAsrMock).toHaveBeenCalledTimes(2);
    expect(transcribeDashScopeAsrMock).toHaveBeenNthCalledWith(
      2,
      "user-1",
      "video:7649250336875613449",
      expect.any(Object),
      { model: "fun-asr", profile: "e3" },
      expect.objectContaining({
        apiKey: "platform-key",
        credentialSource: "platform",
        postprocess: { model: "deepseek-v4-flash", onStart: expect.any(Function) },
      }),
    );
    expect(transcribeDashScopeAsrMock.mock.calls[1]?.[4]).toHaveProperty("clientJobId", "client-job-1:platform");
  });

  it("prompts for a valid custom key when fallback quota is exhausted", async () => {
    transcribeDashScopeAsrMock
      .mockResolvedValueOnce({
        fallbackEligible: true,
        result: { code: "not_configured", detail: "custom unavailable", ok: false },
        status: "failed",
      })
      .mockRejectedValueOnce(new AsrQuotaExceededError());

    const response = await POST(transcribeRequest());

    expect(transcribeDashScopeAsrMock).toHaveBeenCalledTimes(2);
    await expect(readSseEvents(response)).resolves.toContainEqual(expect.objectContaining({
      error: "平台转录剩余额度不足，无法转录当前音频。请前往设置，配置正确且可用的自定义 API Key 后继续使用。",
      type: "error",
    }));
  });

  it("passes E1 inverse text normalization only for the Qwen Filetrans model", async () => {
    const response = await POST(transcribeRequest({
      enableItn: true,
      model: "e1",
    }));

    expect(response.status).toBe(200);
    expect(transcribeDashScopeAsrMock).toHaveBeenCalledWith(
      "user-1",
      "video:7649250336875613449",
      expect.any(Object),
      { enableItn: true, model: "qwen3-asr-flash-filetrans", profile: "e1" },
      {
        apiKey: "test-user-key",
        clientJobId: "client-job-1",
        credentialSource: "custom",
        historyContext: historyContext(),
        postprocess: {
          model: "deepseek-v4-flash",
          onStart: expect.any(Function),
        },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("passes caption context from the owned history session", async () => {
    readTranscriptHistoryRecordMock.mockResolvedValueOnce({
      authorName: "作者",
      authorUrl: "https://www.douyin.com/user/test",
      caption: "Claude Fable 5 回归",
      durationSeconds: 12,
      finalUrl: "https://www.douyin.com/video/7649250336875613449",
      id: "history-1",
      inputUrl: "https://v.douyin.com/abc/",
      workId: "7649250336875613449",
      workKey: "video:7649250336875613449",
      workKind: "video",
    } as Awaited<ReturnType<typeof readTranscriptHistoryRecord>>);

    await POST(transcribeRequest());

    expect(transcribeDashScopeAsrMock).toHaveBeenCalledWith(
      "user-1",
      "video:7649250336875613449",
      expect.any(Object),
      { model: "fun-asr", profile: "e3" },
      expect.objectContaining({
        historyContext: expect.objectContaining({
          work: expect.objectContaining({ caption: "Claude Fable 5 回归" }),
        }),
        postprocess: { model: "deepseek-v4-flash", onStart: expect.any(Function) },
      }),
    );
  });

  it("returns a lifetime platform quota response from the ASR layer", async () => {
    transcribeDashScopeAsrMock.mockRejectedValue(new AsrQuotaExceededError());

    const response = await POST(transcribeRequest());

    expect(response.status).toBe(200);
    await expect(readSseEvents(response)).resolves.toContainEqual(expect.objectContaining({
      error: "平台转录剩余额度不足，无法转录当前音频。请前往设置，配置正确且可用的自定义 API Key 后继续使用。",
      type: "error",
    }));
  });

  it("requires authentication", async () => {
    requireUserMock.mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await POST(transcribeRequest());

    expect(response.status).toBe(401);
  });

  it("refreshes a submitted ASR job by polling DashScope", async () => {
    const response = await GET(new Request("https://echolens.dreamlog.xyz/api/douyin/transcribe?jobId=job-1"));

    expect(response.status).toBe(200);
    expect(refreshDashScopeAsrJobWithOptionsMock).toHaveBeenCalledWith("user-1", "job-1", {
      apiKeys: { custom: "test-user-key", platform: "platform-key" },
      postprocess: {
        onStart: expect.any(Function),
      },
      postprocessModels: { custom: "deepseek-v4-flash", platform: "deepseek-v4-flash" },
      signal: expect.any(AbortSignal),
    });
    expect(upsertTranscriptHistoryRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      id: "history-polled",
      transcriptContent: "轮询转录文本",
      workKey: "video:7649250336875613449",
    }));
    await expect(readSseEvents(response)).resolves.toContainEqual(expect.objectContaining({
      historyRecord: expect.objectContaining({ id: "history-polled" }),
      type: "done",
      results: [
        expect.objectContaining({
          content: "轮询转录文本",
          feature: "audioTranscript",
          status: "success",
        }),
      ],
      status: "successed",
    }));
  });

  it("cancels a submitted ASR job", async () => {
    const response = await DELETE(new Request("https://echolens.dreamlog.xyz/api/douyin/transcribe?jobId=job-1", {
      method: "DELETE",
    }));

    expect(response.status).toBe(200);
    expect(cancelDashScopeAsrJobMock).toHaveBeenCalledWith("user-1", "job-1", {
      custom: "test-user-key",
      platform: "platform-key",
    });
    await expect(response.json()).resolves.toEqual({ canceled: true });
  });

  it("cancels a provider job when the client disconnects after submission", async () => {
    let resolveSubmission: ((value: Awaited<ReturnType<typeof transcribeDashScopeAsr>>) => void) | undefined;
    transcribeDashScopeAsrMock.mockImplementation(() => new Promise((resolve) => {
      resolveSubmission = resolve;
    }));
    const controller = new AbortController();
    const response = await POST(new Request("https://echolens.dreamlog.xyz/api/douyin/transcribe", {
      body: JSON.stringify({
        clientJobId: "client-job-1",
        historyRecordId: "history-1",
      }),
      method: "POST",
      signal: controller.signal,
    }));

    controller.abort();
    resolveSubmission?.({ historyContext: historyContext(), jobId: "provider-job-1", status: "running" });
    await response.text();

    expect(cancelDashScopeAsrJobMock).toHaveBeenCalledWith("user-1", "provider-job-1");
  });

});

function transcribeRequest(extra: Record<string, unknown> = {}): Request {
  return new Request("https://echolens.dreamlog.xyz/api/douyin/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientJobId: "client-job-1",
      historyRecordId: "history-1",
      ...extra,
    }),
  });
}

async function readSseEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split(/\r?\n\r?\n/u)
    .map((event) => event.trim())
    .filter(Boolean)
    .map((event) => {
      const data = event
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return JSON.parse(data) as Record<string, unknown>;
    });
}

function videoWork(): TranscribeWorkPayload {
  return {
    authorName: "作者",
    authorUrl: "https://www.douyin.com/user/test",
    durationSeconds: 12,
    inputUrl: "https://v.douyin.com/abc/",
    finalUrl: "https://www.douyin.com/video/7649250336875613449",
    kind: "video",
    id: "7649250336875613449",
    caption: "测试作品",
  };
}

function historyContext(historyRecordId = "history-1") {
  return {
    historyRecordId,
    work: videoWork(),
  };
}
