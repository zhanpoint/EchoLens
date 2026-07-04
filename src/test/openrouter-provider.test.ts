import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSummarizeTranscript, summarizeTranscript } from "../lib/openrouter/provider";

describe("openrouter provider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_SUMMARY_MODEL: "summary-model",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("summarizes transcript with the configured summary model", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "总结完成" } }] }), { status: 200 }));

    await expect(summarizeTranscript("原始文本", "请总结")).resolves.toEqual({
      ok: true,
      content: "总结完成",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.test/api/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"model":"summary-model"'),
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

  it("streams summary deltas through OpenRouter chat completions", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response([
        'data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n',
        ': OPENROUTER PROCESSING\n\n',
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
      "https://openrouter.test/api/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"stream":true'),
      }),
    );
  });

  it("returns not_configured when OpenRouter API key is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;

    await expect(summarizeTranscript("原始文本", "请总结")).resolves.toEqual({
      ok: false,
      code: "not_configured",
      detail: "OPENROUTER_API_KEY 未配置。",
    });
  });
});
