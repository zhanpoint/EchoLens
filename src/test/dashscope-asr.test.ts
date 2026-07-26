import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDashScopeAsrParameters,
  cancelDashScopeAsrJob,
  getDashScopeAsrModelForProfile,
  parseDashScopeTranscriptPayload,
  refreshDashScopeAsrJob,
  refreshDashScopeAsrJobWithOptions,
} from "@/lib/dashscope/asr";
import {
  markAsrTaskFailed,
  markAsrTaskCanceled,
  markAsrTaskSucceeded,
  deleteAsrTask,
  type StoredAsrTask,
} from "@/lib/transcript/db";

vi.mock("@/lib/transcript/db", () => ({
  deleteAsrTask: vi.fn(async () => true),
  insertAsrTask: vi.fn(),
  markAsrTaskFailed: vi.fn(),
  markAsrTaskCanceled: vi.fn(),
  markAsrTaskRunning: vi.fn(),
  markAsrTaskSucceeded: vi.fn(),
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
    expect(buildDashScopeAsrParameters(e2Options())).toEqual({ channel_id: [0] });
    expect(buildDashScopeAsrParameters(e2Options({ diarizationEnabled: true }))).toEqual({
      channel_id: [0],
      diarization_enabled: true,
    });
    expect(buildDashScopeAsrParameters(e2Options({ diarizationEnabled: true, speakerCount: 3 }))).toEqual({
      channel_id: [0],
      diarization_enabled: true,
      speaker_count: 3,
    });
  });

  it("serializes special_word_filter as the DashScope REST parameter string", () => {
    const specialWordFilter = {
      filter_with_empty: { word_list: ["开始", "发生"] },
      filter_with_signed: { word_list: ["测试"] },
      system_reserved_filter: true,
    };

    expect(buildDashScopeAsrParameters(e2Options({ specialWordFilter }))).toEqual({
      channel_id: [0],
      special_word_filter: JSON.stringify(specialWordFilter),
    });
  });

  it("builds Qwen Filetrans async parameters with sentence-level timestamps", () => {
    expect(buildDashScopeAsrParameters(e1Options())).toEqual({
      enable_words: false,
    });
    expect(buildDashScopeAsrParameters(e1Options({ enableItn: true }))).toEqual({
      enable_itn: true,
      enable_words: false,
    });
  });

  it("rejects special_word_filter for Qwen Filetrans", () => {
    expect(() =>
      buildDashScopeAsrParameters({
        ...e1Options(),
        specialWordFilter: {
          system_reserved_filter: true,
        },
      }),
    ).toThrow("不支持敏感词过滤");
  });

  it("does not include unsupported enhancement parameters for Qwen Filetrans", () => {
    expect(() =>
      buildDashScopeAsrParameters({
        ...e1Options(),
        diarizationEnabled: true,
        specialWordFilter: {
          filter_with_signed: { word_list: ["测试"] },
          system_reserved_filter: true,
        },
      }),
    ).toThrow("不支持说话人分离");
  });

  it("uses the default EchoLens ASR models", () => {
    expect(getDashScopeAsrModelForProfile("e1")).toBe("qwen3-asr-flash-filetrans");
    expect(getDashScopeAsrModelForProfile("e2")).toBe("fun-asr");
  });
});

describe("dashscope ASR polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DASHSCOPE_API_KEY = "key";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refreshes a running ASR task from DashScope task status polling", async () => {
    readAsrTaskMock.mockResolvedValue(task({ model: "qwen3-asr-flash-filetrans" }));
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

    await expect(refreshDashScopeAsrJob("user-1", "job-1")).resolves.toMatchObject({
      result: { content: "轮询转录文本。", ok: true },
      status: "successed",
    });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "https://ws-bj7z459a8sb534fo.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/task-1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(markAsrTaskSucceededMock).toHaveBeenCalledWith("job-1");
  });

  it("cancels the provider task and removes its canceled database record", async () => {
    readAsrTaskMock.mockResolvedValue(task({ model: "qwen3-asr-flash-filetrans" }));
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
    readAsrTaskMock.mockResolvedValue(task({ model: "fun-asr" }));
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
    );
    expect(onPostprocessStart).not.toHaveBeenCalled();
  });

  it("uses the fixed compatible endpoint for required postprocessing", async () => {
    readAsrTaskMock.mockResolvedValue(task({
      model: "qwen3-asr-flash-filetrans",
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
    readAsrTaskMock.mockResolvedValue(task({ model: "fun-asr" }));
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

    await expect(refreshDashScopeAsrJob("user-1", "job-1")).resolves.toMatchObject({
      result: {
        asrModel: "fun-asr",
        content: "原始转录仍然可用",
        ok: true,
      },
      status: "successed",
    });
    expect(markAsrTaskSucceededMock).toHaveBeenCalledWith("job-1");
    expect(markAsrTaskFailedMock).not.toHaveBeenCalled();
  });

  it("recovers when the fifth task-status query succeeds", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    readAsrTaskMock.mockResolvedValue(task({ model: "fun-asr" }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { task_status: "RUNNING" },
      }), { status: 200 }));

    const refresh = refreshDashScopeAsrJob("user-1", "job-1");
    await vi.runAllTimersAsync();

    await expect(refresh).resolves.toEqual({ jobId: "job-1", status: "running" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("returns the unified network error after five task-status query failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    readAsrTaskMock.mockResolvedValue(task({ model: "fun-asr" }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));

    const refresh = refreshDashScopeAsrJob("user-1", "job-1");
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
    readAsrTaskMock.mockResolvedValue(task({ model: "qwen3-asr-flash-filetrans" }));
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

    const refresh = refreshDashScopeAsrJob("user-1", "job-1");
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
  return { model: "qwen3-asr-flash-filetrans", profile: "e1" as const, ...input };
}

function e2Options(input: Partial<Parameters<typeof buildDashScopeAsrParameters>[0]> = {}) {
  return { model: "fun-asr", profile: "e2" as const, ...input };
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
