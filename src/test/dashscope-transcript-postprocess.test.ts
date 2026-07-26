import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamTranscriptPostprocess } from "@/lib/dashscope/transcript-postprocess";

function qwenStream(content: string): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
}

describe("dashscope transcript postprocess", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DASHSCOPE_API_KEY: "test-key",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("uses one streaming path and maps text back to original timestamps", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(qwenStream(
      '[{"id":0,"text":"今天我们讲 A。"},{"id":1,"text":"然后继续。"}]',
    ));

    await expect(streamTranscriptPostprocess({
      content: "今天我们讲 A\n讲 A。然后继续。",
      segments: [
        { endSeconds: 1.2, emotion: "neutral", speakerId: "1", startSeconds: 0, text: "今天我们讲 A" },
        { endSeconds: 2.4, emotion: "happy", speakerId: "2", startSeconds: 1.2, text: "讲 A。然后继续。" },
      ],
      title: "A 主题",
    })).resolves.toMatchObject({
      ok: true,
      content: "今天我们讲 A。\n然后继续。",
      postprocessVersion: "transcript-postprocess-v7",
      transcriptSegments: [
        { endSeconds: 1.2, emotion: "neutral", speakerId: "1", startSeconds: 0, text: "今天我们讲 A。" },
        { endSeconds: 2.4, emotion: "happy", speakerId: "2", startSeconds: 1.2, text: "然后继续。" },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ws-bj7z459a8sb534fo.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as {
      enable_thinking?: boolean;
      messages?: Array<{ content?: string }>;
      stream?: boolean;
      tools?: unknown;
    };
    expect(body.enable_thinking).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.tools).toBeUndefined();
    const prompt = body.messages?.[0]?.content ?? "";
    expect(prompt).toContain("A 主题");
    expect(prompt).toContain("ASR 结果通常准确");
    expect(prompt).toContain("明确的数量、序数、分数、百分比、倍数");
    expect(prompt).toContain("\"startSeconds\":0");
    expect(prompt).not.toContain("speakerId");
    expect(prompt).not.toContain("emotion");
  });

  it("uses the fixed compatible-mode base URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(qwenStream('[{"id":0,"text":"完成"}]'));

    await expect(streamTranscriptPostprocess({ content: "完成" })).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("https://ws-bj7z459a8sb534fo.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", expect.any(Object));
  });

  it("rejects Markdown wrappers and reordered segments", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(qwenStream([
      "```json",
      '[{"id":1,"text":"第二段。"},{"id":0,"text":"第一段。"}]',
      "```",
    ].join("\n")));

    await expect(streamTranscriptPostprocess({
      content: "第一段\n第二段",
      segments: [
        { startSeconds: 0, endSeconds: 1, text: "第一段" },
        { startSeconds: 1, endSeconds: 2, text: "第二段" },
      ],
    })).resolves.toEqual({
      ok: false,
      code: "invalid_response",
      detail: "转录后处理模型返回格式无效，请重试。",
    });
  });

  it("returns an invalid-response error when no JSON array can be recovered", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(qwenStream("不是 JSON"));

    await expect(streamTranscriptPostprocess({ content: "完成" })).resolves.toEqual({
      ok: false,
      code: "invalid_response",
      detail: "转录后处理模型返回格式无效，请重试。",
    });
  });
});
