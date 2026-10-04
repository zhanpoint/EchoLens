import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), checkpoint: vi.fn(), succeed: vi.fn(), fail: vi.fn(), postprocess: vi.fn(), reserve: vi.fn(), attach: vi.fn() }));
vi.mock("@/lib/dashscope/user-credential", () => ({ readDashScopeApiKeyForUser: vi.fn(async () => "key") }));
vi.mock("@/lib/dashscope/transcript-postprocess", () => ({ streamTranscriptPostprocess: mocks.postprocess }));
vi.mock("@/lib/transcript/db", () => ({
  readAsrTask: mocks.read, readRunningAsrTask: vi.fn(async () => null), reserveAsrTask: mocks.reserve,
  checkpointAsrTaskResult: mocks.checkpoint, markAsrTaskSucceeded: mocks.succeed, markAsrTaskFailed: mocks.fail,
  attachAsrTaskProviderTask: mocks.attach, markAsrTaskCanceled: vi.fn(), markAsrTaskRunning: vi.fn(), deleteAsrTask: vi.fn(),
}));
import { buildDashScopeAsrParameters, parseDashScopeFlashTranscriptPayload, submitDashScopeAsrJob, refreshDashScopeAsrJobWithOptions } from "@/lib/dashscope/asr";
import { DASHSCOPE_ASR_FLASH_MODEL as model } from "@/lib/dashscope/model-config";
const audio = { durationSeconds: 30, objectKey: "audio.m4a", signedUrl: "https://oss.test/audio.m4a" };
const payload = { output: { text: "你好世界", sentences: [
  { text: "你好", begin_time: 0, end_time: 1000, speaker_id: 0 },
  { text: "世界", begin_time: 1000, end_time: 2000, speaker_id: 1 },
] } };
beforeEach(() => {
  vi.clearAllMocks(); mocks.read.mockResolvedValue(null); mocks.reserve.mockResolvedValue(true);
  mocks.checkpoint.mockResolvedValue(true); mocks.succeed.mockResolvedValue(true);
  mocks.fail.mockResolvedValue(undefined);
  mocks.attach.mockResolvedValue(true);
  mocks.postprocess.mockResolvedValue({ ok: true, content: "整理后的文字" });
});
afterEach(() => vi.restoreAllMocks());

describe("E1 synchronous short audio", () => {
  it("consumes sentence revisions from SSE without duplicating partial text", async () => {
    const sentence = { sentence_id: 0, begin_time: 0, end_time: 1000, text: "你", sentence_end: false };
    const packets = [
      { output: { sentence } },
      { output: { sentence: { ...sentence, text: "你好", sentence_end: true } } },
      { output: { sentence: { sentence_id: 1, begin_time: 1000, end_time: 2000, text: "世界", sentence_end: true } } },
    ];
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      packets.map(packet => `data: ${JSON.stringify(packet)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } },
    ));
    await expect(submitDashScopeAsrJob("user", "video:1", audio, { model }, { clientJobId: "stream", apiKey: "key" }))
      .resolves.toMatchObject({ status: "successed" });
    expect(fetch.mock.calls[0][1]?.headers).toHaveProperty("x-dashscope-sse", "enable");
    expect(mocks.checkpoint).toHaveBeenCalledWith("stream", expect.objectContaining({ content: "你好\n世界" }));
  });
  it("rejects a prematurely terminated stream without saving incomplete recognition", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      `data: ${JSON.stringify({ output: { sentence: { sentence_id: 0, begin_time: 0, end_time: 1000, text: "未完成", sentence_end: false } } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ));
    await expect(submitDashScopeAsrJob("user", "video:1", audio, { model }, { clientJobId: "stream", apiKey: "key" }))
      .resolves.toMatchObject({ status: "failed", result: { submissionUncertain: true } });
    expect(mocks.checkpoint).not.toHaveBeenCalled();
  });
  it("switches a definitively rejected Flash request to Filetrans under the same reserved job", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ code: "BadRequest", message: "[asr]Backend buffer overflow." }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ output: { task_id: "accepted-file" } }));
    await expect(submitDashScopeAsrJob("user", "video:1", audio, { model }, { clientJobId: "job", apiKey: "key" }))
      .resolves.toMatchObject({ status: "running", jobId: "job" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).model).toBe("qwen-audio-3.1-asr-flash-filetrans");
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ id: "job", taskId: "accepted-file", model: "qwen-audio-3.1-asr-flash-filetrans" }));
  });
  it("uses the native Flash protocol and checkpoints recognition before postprocessing", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payload));
    const result = await submitDashScopeAsrJob("user", "video:1", audio, { model, diarizationEnabled: true, speakerCount: 3 }, { clientJobId: "job", apiKey: "key" });
    expect(result).toMatchObject({ status: "successed", result: { asrModel: model, content: "整理后的文字" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain("/services/aigc/multimodal-generation/generation");
    expect(JSON.parse(String(init?.body))).toEqual({ model, input: { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: audio.signedUrl } }] }] }, parameters: { format: "m4a", speaker_diarization_enabled: true } });
    expect(init?.headers).not.toHaveProperty("x-dashscope-async");
    expect(mocks.checkpoint).toHaveBeenCalledWith("job", expect.objectContaining({ ok: true, asrModel: model, content: "你好\n世界" }));
    expect(mocks.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(mocks.postprocess.mock.invocationCallOrder[0]);
    expect(buildDashScopeAsrParameters({ model: "qwen-audio-3.1-asr-flash-filetrans", diarizationEnabled: true, speakerCount: 3 })).toEqual({ channel_id: [0], diarization_enabled: true, speaker_count: 3 });
  });
  it("resumes persisted Flash results without another ASR request", async () => {
    mocks.read.mockResolvedValue({ id: "job", userId: "user", model, status: "running", taskId: "pending:job", credentialSource: "platform", updatedAt: Date.now(), result: { ok: true, content: "已识别的文字" } });
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await refreshDashScopeAsrJobWithOptions("user", "job", { apiKey: "key" })).toMatchObject({ status: "successed" });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.postprocess).toHaveBeenCalledWith(expect.objectContaining({ content: "已识别的文字" }));
  });
  it("keeps the checkpoint when postprocessing fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payload));
    mocks.postprocess.mockResolvedValue({ ok: false, code: "not_configured", detail: "后处理凭据失效" });
    expect(await submitDashScopeAsrJob("user", "video:1", audio, { model }, { clientJobId: "job", apiKey: "key" })).toMatchObject({ status: "failed" });
    expect(mocks.checkpoint).toHaveBeenCalled(); expect(mocks.fail).not.toHaveBeenCalled();
  });
  it("does not repeat an ambiguous synchronous submission or fall back to another billed request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connection lost"));
    expect(await submitDashScopeAsrJob("user", "video:1", audio, { model }, { apiKey: "key" })).toMatchObject({ status: "failed", fallbackEligible: false });
    expect(fetch).toHaveBeenCalledTimes(1); expect(mocks.checkpoint).not.toHaveBeenCalled();
  });
  it("expires interrupted synchronous submissions instead of polling forever", async () => {
    mocks.read.mockResolvedValue({ id: "job", model, status: "running", credentialSource: "platform", updatedAt: Date.now() - 121_000 });
    expect(await refreshDashScopeAsrJobWithOptions("user", "job", { apiKey: "key" })).toMatchObject({ status: "failed", result: { detail: expect.stringContaining("提交确认中断") } });
  });
  it("handles single-sentence responses and silence", () => {
    expect(parseDashScopeFlashTranscriptPayload({ output: { text: "你好", sentence: payload.output.sentences[0] } })).toMatchObject({ content: "你好", transcriptSegments: [{ text: "你好", speakerId: "1", startSeconds: 0, endSeconds: 1 }] });
    expect(parseDashScopeFlashTranscriptPayload({ output: { text: "", sentence: { text: "" } } })).toBeNull();
  });
});
