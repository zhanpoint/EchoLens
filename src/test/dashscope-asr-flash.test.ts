import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), checkpoint: vi.fn(), succeed: vi.fn(), fail: vi.fn(), postprocess: vi.fn(), reserve: vi.fn() }));
vi.mock("@/lib/dashscope/user-credential", () => ({ readDashScopeApiKeyForUser: vi.fn(async () => "key") }));
vi.mock("@/lib/dashscope/transcript-postprocess", () => ({ streamTranscriptPostprocess: mocks.postprocess }));
vi.mock("@/lib/transcript/db", () => ({
  readAsrTask: mocks.read, readRunningAsrTask: vi.fn(async () => null), reserveAsrTask: mocks.reserve,
  checkpointAsrTaskResult: mocks.checkpoint, markAsrTaskSucceeded: mocks.succeed, markAsrTaskFailed: mocks.fail,
  attachAsrTaskProviderTask: vi.fn(), markAsrTaskCanceled: vi.fn(), markAsrTaskRunning: vi.fn(), deleteAsrTask: vi.fn(),
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
  mocks.postprocess.mockResolvedValue({ ok: true, content: "整理后的文字" });
});
afterEach(() => vi.restoreAllMocks());

describe("E1 synchronous short audio", () => {
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
