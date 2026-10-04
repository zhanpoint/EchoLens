import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDashScopeAsrParameters,
  cancelDashScopeAsrJob,
  getDashScopeAsrModel,
  parseDashScopeTranscriptPayload,
  refreshDashScopeAsrJobWithOptions,
} from "@/lib/dashscope/asr";
import { DEFAULT_DASHSCOPE_MODELS, readEnvironmentDashScopeModelIds } from "@/lib/dashscope/model-config";
import {
  markAsrTaskFailed,
  markAsrTaskCanceled,
  markAsrTaskSucceeded,
  deleteAsrTask,
  type StoredAsrTask,
} from "@/lib/transcript/db";

vi.mock("@/lib/dashscope/user-credential", () => ({
  readDashScopeApiKeyForUser: vi.fn(async () => process.env.DASHSCOPE_API_KEY),
}));

vi.mock("@/lib/transcript/db", () => ({
  deleteAsrTask: vi.fn(async () => true),
  markAsrTaskFailed: vi.fn(),
  markAsrTaskCanceled: vi.fn(),
  markAsrTaskRunning: vi.fn(),
  markAsrTaskSucceeded: vi.fn(),
  checkpointAsrTaskResult: vi.fn(async () => true),
  readAsrTask: vi.fn(),
  readRunningAsrTask: vi.fn(),
}));

import { readAsrTask } from "@/lib/transcript/db";

const markAsrTaskSucceededMock = vi.mocked(markAsrTaskSucceeded);
const markAsrTaskFailedMock = vi.mocked(markAsrTaskFailed);
const readAsrTaskMock = vi.mocked(readAsrTask);
const deleteAsrTaskMock = vi.mocked(deleteAsrTask);

describe("dashscope ASR transcript parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads the current model configuration without obsolete E2 or E3 environment variables", () => {
    vi.stubEnv("DASHSCOPE_ASR_MODEL_E1", DEFAULT_DASHSCOPE_MODELS.asrE1);
    vi.stubEnv("DASHSCOPE_TRANSLATION_MODEL", DEFAULT_DASHSCOPE_MODELS.translation);
    vi.stubEnv("DASHSCOPE_TRANSCRIPT_POSTPROCESS_MODEL", DEFAULT_DASHSCOPE_MODELS.transcriptPostprocess);
    vi.stubEnv("DASHSCOPE_SUMMARY_MODEL", DEFAULT_DASHSCOPE_MODELS.summary);
    vi.stubEnv("DASHSCOPE_ASR_MODEL_E2", undefined);
    vi.stubEnv("DASHSCOPE_ASR_MODEL_E3", undefined);
    try {
      expect(readEnvironmentDashScopeModelIds()).toEqual(DEFAULT_DASHSCOPE_MODELS);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("parses transcript text and sentence timestamps", () => {
    const parsed = parseDashScopeTranscriptPayload({
      transcripts: [
        {
          text: "你好世界",
          sentences: [
            {
              begin_time: 0,
              end_time: 1200,
              speaker_id: 0,
              text: "你好",
            },
            {
              begin_time: 1200,
              end_time: 2600,
              speaker_id: 1,
              text: "世界",
            },
          ],
        },
      ],
    });

    expect(parsed).toEqual({
      content: "你好\n世界",
      transcriptSegments: [
        { startSeconds: 0, endSeconds: 1.2, speakerId: "1", text: "你好" },
        { startSeconds: 1.2, endSeconds: 2.6, speakerId: "2", text: "世界" },
      ],
    });
  });

  it("keeps recognized text unchanged before required Qwen postprocessing", () => {
    const parsed = parseDashScopeTranscriptPayload({
      transcripts: [
        {
          sentences: [
            {
              begin_time: 0,
              end_time: 900,
              text: "完整正文",
            },
            {
              begin_time: 900,
              end_time: 1200,
              text: "抖音",
            },
          ],
        },
      ],
    });

    expect(parsed).toEqual({
      content: "完整正文\n抖音",
      transcriptSegments: [
        { startSeconds: 0, endSeconds: 0.9, text: "完整正文" },
        { startSeconds: 0.9, endSeconds: 1.2, text: "抖音" },
      ],
    });
  });

  it("parses Qwen Filetrans sentence emotions", () => {
    const parsed = parseDashScopeTranscriptPayload({
      transcripts: [
        {
          text: "欢迎使用阿里云。",
          sentences: [
            {
              begin_time: 0,
              emotion: "neutral",
              end_time: 1200,
              text: "欢迎使用阿里云。",
            },
          ],
        },
      ],
    });

    expect(parsed).toEqual({
      content: "欢迎使用阿里云。",
      emotions: ["neutral"],
      transcriptSegments: [
        { startSeconds: 0, endSeconds: 1.2, emotion: "neutral", text: "欢迎使用阿里云。" },
      ],
    });
  });

  it("builds diarization parameters only when enabled", () => {
    expect(buildDashScopeAsrParameters(e1Options())).toEqual({ channel_id: [0] });
    expect(buildDashScopeAsrParameters(e1Options({ diarizationEnabled: true }))).toEqual({
      channel_id: [0],
      diarization_enabled: true,
    });
    expect(buildDashScopeAsrParameters(e1Options({ diarizationEnabled: true, speakerCount: 3 }))).toEqual({
      channel_id: [0],
      diarization_enabled: true,
      speaker_count: 3,
    });
  });





  it("uses the default EchoLens ASR models", () => {
    expect(getDashScopeAsrModel(undefined)).toBe("qwen-audio-3.1-asr-flash-filetrans");
    expect(getDashScopeAsrModel(300)).toBe("qwen-audio-3.1-asr-flash");
    expect(getDashScopeAsrModel(300.01)).toBe("qwen-audio-3.1-asr-flash-filetrans");
  });
});

describe("dashscope ASR polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DASHSCOPE_API_KEY = "key";
    markAsrTaskSucceededMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])("refreshes ASR polling and reuses concurrent completion (%s)", async (concurrent) => {
    readAsrTaskMock.mockResolvedValue(task({ model: "qwen-audio-3.1-asr-flash-filetrans" }));
    if (concurrent) {
      markAsrTaskSucceededMock.mockResolvedValue(false);
      readAsrTaskMock.mockResolvedValueOnce(task({ model: "qwen-audio-3.1-asr-flash-filetrans" })).mockResolvedValue({
        ...task({ model: "qwen-audio-3.1-asr-flash-filetrans" }), status: "succeeded", result: { ok: true, content: "轮询转录文本。" },
      });
    }
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          output: {
            result: {
              transcription_url: "https://dashscope.example.com/qwen-result.json",
            },
            task_status: "SUCCEEDED",
          },
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          transcripts: [
            {
              text: "轮询转录文本",
              sentences: [{ begin_time: 0, end_time: 1000, text: "轮询转录文本" }],
            },
          ],
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response([
          `data: ${JSON.stringify({
            choices: [{ delta: { content: '[{"id":0,"text":"轮询转录文本。"}]' } }],
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        }),
      );

    await expect(refreshDashScopeAsrJobWithOptions("user-1", "job-1")).resolves.toMatchObject({
      result: { content: "轮询转录文本。", ok: true },
      status: "successed",
    });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "https://ws-bj7z459a8sb534fo.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/task-1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(markAsrTaskSucceededMock).toHaveBeenCalledWith("job-1", expect.objectContaining({ ok: true }));
  });

  it("cancels the provider task and removes its canceled database record", async () => {
    readAsrTaskMock.mockResolvedValue(task({ model: "qwen-audio-3.1-asr-flash-filetrans" }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await expect(cancelDashScopeAsrJob("user-1", "job-1")).resolves.toBe(true);

    expect(markAsrTaskCanceled).toHaveBeenCalledWith("job-1");
    expect(deleteAsrTaskMock).toHaveBeenCalledWith({ id: "job-1", userId: "user-1" });
  });

  it.each([
    "ASR_RESPONSE_HAVE_NO_WORDS",
    "SUCCESS_WITH_NO_VALID_FRAGMENT",
  ])("maps %s to a friendly no-speech result without postprocessing", async (providerCode) => {
    const onPostprocessStart = vi.fn();
    readAsrTaskMock.mockResolvedValue(task({ model: "qwen-audio-3.1-asr-flash-filetrans" }));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      output: {
        code: providerCode,
        message: providerCode,
        task_status: "FAILED",
      },
    }), { status: 200 }));

    await expect(refreshDashScopeAsrJobWithOptions("user-1", "job-1", {
      postprocess: { onStart: onPostprocessStart },
    })).resolves.toEqual({
      status: "failed",
      result: {
        ok: false,
        code: "no_speech",
        detail: "未检测到可识别的语音。暂不支持转录纯静音、仅背景噪声或没有人声的音频。",
      },
    });
    expect(markAsrTaskFailedMock).toHaveBeenCalledWith(
      "job-1",
      "未检测到可识别的语音。暂不支持转录纯静音、仅背景噪声或没有人声的音频。",
      expect.objectContaining({ ok: false, code: "no_speech" }),
    );
    expect(onPostprocessStart).not.toHaveBeenCalled();
  });

  it("persists a structured no-speech failure when a successful provider task contains no words", async () => {
    readAsrTaskMock.mockResolvedValue(task({ model: "qwen-audio-3.1-asr-flash-filetrans" }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: {
        task_status: "SUCCEEDED", result: { transcription_url: "https://dashscope.example.com/empty.json" },
      } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ transcripts: [{ sentences: [] }] }), { status: 200 }));
    await expect(refreshDashScopeAsrJobWithOptions("user-1", "job-1")).resolves.toMatchObject({
      status: "failed", result: { ok: false, code: "no_speech" },
    });
    expect(markAsrTaskFailedMock).toHaveBeenCalledWith("job-1", expect.any(String),
      expect.objectContaining({ ok: false, code: "no_speech" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markAsrTaskSucceededMock).not.toHaveBeenCalled();
  });

  it("uses the fixed compatible endpoint for required postprocessing", async () => {
    readAsrTaskMock.mockResolvedValue(task({
      model: "qwen-audio-3.1-asr-flash-filetrans",
      caption: "中文作品标题",
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          output: {
            result: {
              transcription_url: "https://dashscope.example.com/qwen-result.json",
            },
            task_status: "SUCCEEDED",
          },
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          transcripts: [
            {
              sentences: [{ begin_time: 0, end_time: 1000, text: "原始转录文本" }],
            },
          ],
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"[{\\"id\\":0,\\"text\\":\\"原始转录文本\\"}]"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { status: 200 }));

    await expect(refreshDashScopeAsrJobWithOptions("user-1", "job-1", {
      postprocess: {},
    })).resolves.toMatchObject({
      result: { content: "原始转录文本", ok: true },
      status: "successed",
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      "https://ws-bj7z459a8sb534fo.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      expect.any(Object),
    );
    const requestBody = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as {
      messages?: Array<{ content?: string }>;
    };
    expect(requestBody.messages?.[0]?.content).toContain("中文作品标题");
  });
  it("keeps the successful raw ASR result when postprocessing returns invalid output", async () => {
    readAsrTaskMock.mockResolvedValue(task({ model: "qwen-audio-3.1-asr-flash-filetrans" }));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: {
          result: { transcription_url: "https://dashscope.example.com/raw-result.json" },
          task_status: "SUCCEEDED",
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        transcripts: [{
          sentences: [{ begin_time: 0, end_time: 1000, text: "原始转录仍然可用" }],
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"无法按要求输出 JSON"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { status: 200 }));

    await expect(refreshDashScopeAsrJobWithOptions("user-1", "job-1")).resolves.toMatchObject({
      result: {
        asrModel: "qwen-audio-3.1-asr-flash-filetrans",
        content: "原始转录仍然可用",
        ok: true,
      },
      status: "successed",
    });
    expect(markAsrTaskSucceededMock).toHaveBeenCalledWith("job-1", expect.objectContaining({ ok: true }));
    expect(markAsrTaskFailedMock).not.toHaveBeenCalled();
  });

  it("recovers when the fifth task-status query succeeds", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    readAsrTaskMock.mockResolvedValue(task({ model: "qwen-audio-3.1-asr-flash-filetrans" }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { task_status: "RUNNING" },
      }), { status: 200 }));

    const refresh = refreshDashScopeAsrJobWithOptions("user-1", "job-1");
    await vi.runAllTimersAsync();

    await expect(refresh).resolves.toEqual({ jobId: "job-1", status: "running" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("returns the unified network error after five task-status query failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    readAsrTaskMock.mockResolvedValue(task({ model: "qwen-audio-3.1-asr-flash-filetrans" }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));

    const refresh = refreshDashScopeAsrJobWithOptions("user-1", "job-1");
    await vi.runAllTimersAsync();

    await expect(refresh).resolves.toMatchObject({
      status: "failed",
      result: {
        code: "NETWORK_RETRY_EXHAUSTED",
        detail: "网络连接失败，请检查网络后重试。",
        ok: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(markAsrTaskFailedMock).not.toHaveBeenCalled();
  });

  it("retries transcript-result downloads without repeating the task query", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    readAsrTaskMock.mockResolvedValue(task({ model: "qwen-audio-3.1-asr-flash-filetrans" }));
    const resultUrl = "https://dashscope.example.com/retry-result.json";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: {
          result: { transcription_url: resultUrl },
          task_status: "SUCCEEDED",
        },
      }), { status: 200 }))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        transcripts: [{
          sentences: [{ begin_time: 0, end_time: 1000, text: "下载恢复" }],
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"[{\\"id\\":0,\\"text\\":\\"下载恢复。\\"}]"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { status: 200 }));

    const refresh = refreshDashScopeAsrJobWithOptions("user-1", "job-1");
    await vi.runAllTimersAsync();

    await expect(refresh).resolves.toMatchObject({
      status: "successed",
      result: { content: "下载恢复。", ok: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === resultUrl)).toHaveLength(5);
  });

});

function e1Options(input: Partial<Parameters<typeof buildDashScopeAsrParameters>[0]> = {}) {
  return { model: "qwen-audio-3.1-asr-flash-filetrans", ...input };
}


function task(input: { caption?: string; model: string }): StoredAsrTask {
  return {
    audioDurationSeconds: 60,
    cacheKey: "cache-1",
    credentialSource: "platform",
    ...(input.caption ? {
      historyContext: {
        historyRecordId: "history-1",
        work: {
          caption: input.caption,
          finalUrl: "https://www.douyin.com/video/7649250336875613449",
          id: "7649250336875613449",
          inputUrl: "https://v.douyin.com/test/",
          kind: "video",
        },
      },
    } : {}),
    id: "job-1",
    model: input.model,
    objectKey: "echolens/media/video/1/audio.m4a",
    status: "running",
    taskId: "task-1",
    updatedAt: Date.now(),
    userId: "user-1",
    workKey: "video:1",
  };
}
