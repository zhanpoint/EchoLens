import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamQwenMtText, translateQwenMtTextItems } from "../lib/dashscope/translation";

describe("dashscope qwen-mt translation", () => {
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

  it("calls qwen-mt-flash with official translation_options fields", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { status: 200 }));

    const deltas: string[] = [];
    await expect(streamQwenMtText({
      text: "你好",
      options: {
        source_lang: "auto",
        target_lang: "English",
        domains: "Translate into concise IT documentation style.",
        terms: [{ source: "术语", target: "term" }],
        tm_list: [{ source: "点击下载", target: "Click Download" }],
      },
      onDelta: (delta) => deltas.push(delta),
    })).resolves.toEqual({ ok: true, content: "Hello" });
    expect(deltas).toEqual(["Hello"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ws-bj7z459a8sb534fo.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      expect.objectContaining({
        body: JSON.stringify({
          model: "qwen-mt-flash",
          messages: [{ role: "user", content: "你好" }],
          stream: true,
          stream_options: { include_usage: false },
          translation_options: {
            source_lang: "auto",
            target_lang: "English",
            domains: "Translate into concise IT documentation style.",
            terms: [{ source: "术语", target: "term" }],
            tm_list: [{ source: "点击下载", target: "Click Download" }],
          },
        }),
      }),
    );
  });

  it("converts qwen-mt-plus cumulative stream chunks into incremental deltas", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""), { status: 200 }));

    const deltas: string[] = [];
    await expect(streamQwenMtText({
      model: "qwen-mt-plus",
      text: "你好",
      options: { source_lang: "auto", target_lang: "English" },
      onDelta: (delta) => deltas.push(delta),
    })).resolves.toEqual({ ok: true, content: "Hello" });
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("uses the fixed compatible-mode base URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n', { status: 200 }));

    await expect(streamQwenMtText({
      text: "你好",
      options: { source_lang: "auto", target_lang: "English" },
      onDelta: () => undefined,
    })).resolves.toEqual({ ok: true, content: "Hello" });
    expect(fetchMock).toHaveBeenCalledWith("https://ws-bj7z459a8sb534fo.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", expect.any(Object));
  });

  it("streams incremental deltas", async () => {
    vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { status: 200 }));

    const deltas: string[] = [];
    await expect(streamQwenMtText({
      text: "你好",
      options: { source_lang: "auto", target_lang: "English" },
      onDelta: (delta) => deltas.push(delta),
    })).resolves.toEqual({ ok: true, content: "Hello" });
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("translates multiple timed text items in one model request", async () => {
    const firstKey = "segment:0-1";
    const secondKey = "segment:1-2";
    const controller = new AbortController();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response([
        "data: ",
        JSON.stringify({
          choices: [{
            delta: {
              content: [
                "⟦0⟧",
                "Hello.",
                "⟦/0⟧",
                "",
                "⟦1⟧",
                "How are you?",
                "⟦/1⟧",
              ].join("\n"),
            },
          }],
        }),
        "\n\n",
        "data: [DONE]\n\n",
      ].join(""), { status: 200 }));

    await expect(translateQwenMtTextItems({
      items: [
        { key: firstKey, text: "你好。" },
        { key: secondKey, text: "你好吗？" },
      ],
      options: { source_lang: "auto", target_lang: "English" },
      signal: controller.signal,
    })).resolves.toEqual([
      { key: firstKey, ok: true, content: "Hello." },
      { key: secondKey, ok: true, content: "How are you?" },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(requestInit?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toContain("⟦0⟧");
    expect(body.messages[0].content).toContain("⟦1⟧");
    controller.abort();
    expect(requestInit?.signal?.aborted).toBe(true);
  });

  it("bisects a malformed batch response instead of returning misaligned translations", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"⟦0⟧\\nHello.\\n⟦/0⟧\\nHow are you?"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { status: 200 }))
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"Hello."}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { status: 200 }))
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"How are you?"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { status: 200 }));

    await expect(translateQwenMtTextItems({
      items: [
        { key: "segment:0-1", text: "你好。" },
        { key: "segment:1-2", text: "你好吗？" },
      ],
      options: { source_lang: "auto", target_lang: "English" },
    })).resolves.toEqual([
      { key: "segment:0-1", ok: true, content: "Hello." },
      { key: "segment:1-2", ok: true, content: "How are you?" },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requestBodies = fetchMock.mock.calls.map(([, requestInit]) =>
      JSON.parse(String(requestInit?.body)) as { messages: Array<{ content: string }> }
    );
    expect(requestBodies[0].messages[0].content).toContain("⟦0⟧");
    expect(requestBodies[1].messages[0].content).toBe("你好。");
    expect(requestBodies[2].messages[0].content).toBe("你好吗？");
  });

  it("resets partial translation before a successful stream retry", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const encoder = new TextEncoder();
    let sent = false;
    const broken = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Part"}}]}\n\n'));
          return;
        }
        controller.error(new Error("socket terminated"));
      },
    }), { status: 200 });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"Complete"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { status: 200 }));
    const events: string[] = [];

    const translation = streamQwenMtText({
      text: "你好",
      options: { source_lang: "auto", target_lang: "English" },
      onDelta: (delta) => events.push(`delta:${delta}`),
      onReset: () => events.push("replace"),
    });
    await vi.runAllTimersAsync();

    await expect(translation).resolves.toEqual({ ok: true, content: "Complete" });
    expect(events).toEqual(["delta:Part", "replace", "delta:Complete"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns not_configured when DashScope API key is missing", async () => {
    delete process.env.DASHSCOPE_API_KEY;

    await expect(streamQwenMtText({
      text: "你好",
      options: { source_lang: "auto", target_lang: "English" },
      onDelta: () => undefined,
    })).resolves.toEqual({
      ok: false,
      code: "not_configured",
      detail: "DASHSCOPE_API_KEY 未配置。",
    });
  });

  it("requires an explicit target language", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(streamQwenMtText({
      text: "你好",
      options: { source_lang: "auto", target_lang: " " },
      onDelta: () => undefined,
    })).resolves.toEqual({
      ok: false,
      code: "unavailable",
      detail: "请选择目标语言。",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
