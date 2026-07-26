import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSummarizeTranscript } from "@/lib/dashscope/summary";

describe("dashscope summary", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DASHSCOPE_API_KEY: "test-key",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("streams summary deltas through DashScope chat completions", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response([
        'data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n',
        ": DASHSCOPE PROCESSING\n\n",
        'data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }));

    const deltas: string[] = [];
    await expect(streamSummarizeTranscript({
      transcript: "原始文本",
      prompt: "请总结",
      onDelta: (delta) => deltas.push(delta),
    })).resolves.toEqual({
      ok: true,
      content: "第一段第二段",
    });

    expect(deltas).toEqual(["第一段", "第二段"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ws-bj7z459a8sb534fo.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"stream":true'),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as {
      messages: Array<{ content: unknown; role: string }>;
    };
    expect(body.messages[0]?.role).toBe("user");
    expect(typeof body.messages[0]?.content).toBe("string");
    expect(body.messages[0]?.content).toContain("用户任务：\n请总结");
    expect(body.messages[0]?.content).toContain("转写文本：\n原始文本");
  });

  it("replaces partial output before recovering from a broken stream", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(brokenSseResponse("半截内容"))
      .mockResolvedValueOnce(sseResponse("完整总结"));
    const events: string[] = [];

    const summary = streamSummarizeTranscript({
      transcript: "原始文本",
      prompt: "请总结",
      onDelta: (delta) => events.push(`delta:${delta}`),
      onReset: () => events.push("replace"),
    });
    await vi.runAllTimersAsync();

    await expect(summary).resolves.toEqual({ ok: true, content: "完整总结" });
    expect(events).toEqual(["delta:半截内容", "replace", "delta:完整总结"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the unified network error after five broken streams", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => brokenSseResponse("半截"));
    const onReset = vi.fn();

    const summary = streamSummarizeTranscript({
      transcript: "原始文本",
      prompt: "请总结",
      onDelta: () => undefined,
      onReset,
    });
    await vi.runAllTimersAsync();

    await expect(summary).resolves.toEqual({
      ok: false,
      code: "NETWORK_RETRY_EXHAUSTED",
      detail: "网络连接失败，请检查网络后重试。",
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(onReset).toHaveBeenCalledTimes(4);
  });

  it("does not retry a non-transient model error", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { code: "InvalidParameter", message: "invalid prompt" },
    }), { status: 400 }));

    await expect(streamSummarizeTranscript({
      transcript: "原始文本",
      prompt: "请总结",
      onDelta: () => undefined,
    })).resolves.toEqual({
      ok: false,
      code: "error",
      detail: "invalid prompt",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns not_configured when DashScope API key is missing", async () => {
    delete process.env.DASHSCOPE_API_KEY;

    await expect(streamSummarizeTranscript({
      transcript: "原始文本",
      prompt: "请总结",
      onDelta: () => undefined,
    })).resolves.toEqual({
      ok: false,
      code: "not_configured",
      detail: "DASHSCOPE_API_KEY 未配置。",
    });
  });
});

function sseResponse(content: string): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { status: 200 });
}

function brokenSseResponse(content: string): Response {
  const encoder = new TextEncoder();
  let sent = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        return;
      }
      controller.error(new Error("socket terminated"));
    },
  }), { status: 200 });
}