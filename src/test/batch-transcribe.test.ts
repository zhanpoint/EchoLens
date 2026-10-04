import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  readAsr: vi.fn(),
  refresh: vi.fn(),
  submit: vi.fn(),
  prepare: vi.fn(),
  cachedAudio: vi.fn(),
  checkpoint: vi.fn(),
  save: vi.fn(),
  markFailed: vi.fn(),
  history: vi.fn(),
}));
vi.mock("@/lib/bilibili/client", () => ({
  resolveBilibiliWork: mocks.resolve,
  buildBilibiliWorkId: (bvid: string, cid: number) => `${bvid}:${cid}`,
  getBilibiliDashSelection: vi.fn(async () => ({
    audio: { urls: [] },
    video: { urls: [], id: 64 },
  })),
}));
vi.mock("@/lib/bilibili/account", () => ({
  readUsableBilibiliCookie: () => "",
}));
vi.mock("@/lib/douyin/account", () => ({ readDouyinCredentialState: vi.fn() }));
vi.mock("@/lib/user-settings", () => ({ readUserSetting: vi.fn() }));
vi.mock("@/lib/dashscope/user-credential", () => ({
  readDashScopeUserConfig: vi.fn(async () => ({
    platformApiKey: "key",
    customModels: { transcriptPostprocess: "model" },
    platformModels: { asrE1: "qwen-audio-3.1-asr-flash-filetrans", transcriptPostprocess: "model" },
  })),
}));
vi.mock("@/lib/dashscope/asr", () => ({
  submitDashScopeAsrJob: mocks.submit,
  refreshDashScopeAsrJobWithOptions: mocks.refresh,
}));
vi.mock("@/lib/transcript/assets", () => ({
  ensureHistoryAsset: mocks.cachedAudio,
  prepareBilibiliSnapshotAsset: mocks.prepare,
  prepareDouyinSnapshotAsset: mocks.prepare,
}));
vi.mock("@/lib/transcript/db", () => ({
  readAsrTask: mocks.readAsr,
  findOrCreateTranscriptHistoryRecord: mocks.history,
  updateTranscriptHistoryRecordTranscript: mocks.save,
  markAsrTaskFailed: mocks.markFailed,
}));
vi.mock("@/lib/batch/db", () => ({ checkpointItem: mocks.checkpoint }));
import {
  transcribeBatchItem,
} from "@/lib/batch/transcribe";
import type { ClaimedItem } from "@/lib/batch/db";
import { FfmpegProcessError } from "@/lib/media/ffmpeg-runner";
const item = (): ClaimedItem => ({
  id: "item",
  batch_id: "batch",
  user_id: "owner",
  platform: "bilibili",
  model: "e1",
  generation: 0,
  retries: 0,
  lease_token: "lease",
  asr_job_id: null,
  completed_parts: [],
  part_count: 0,
  video: {
    id: "BV1test",
    title: "视频标题",
    coverUrl: "",
    durationSeconds: 60,
    publishedAt: 0,
  },
});
const result = {
  status: "successed",
  result: { ok: true, content: "转录结果" },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({
    metadata: {
      bvid: "BV1test",
      cid: 1,
      authorAvatarUrls: [],
      coverUrls: [],
      authorName: "UP",
      pages: [{ cid: 1, page: 1, part: "第一节", durationSeconds: 60 }],
    },
  });
  mocks.readAsr.mockResolvedValue(null);
  mocks.submit.mockResolvedValue(result);
  mocks.refresh.mockResolvedValue(result);
  mocks.history.mockResolvedValue({ record: { id: "history" } });
  mocks.prepare.mockResolvedValue({
    objectKey: "audio",
    url: "https://oss/audio",
    durationSeconds: 60,
  });
});
describe("batch ASR checkpoint recovery", () => {
  it("polls an accepted cloud task without re-reading platform metadata or preparing audio", async () => {
    mocks.readAsr.mockResolvedValue({
      id: "cloud", taskId: "provider", status: "running",
      historyContext: { historyRecordId: "history", work: { id: "BV1test:1", caption: "视频" } },
    });
    mocks.refresh.mockResolvedValue({ status: "running", jobId: "cloud" });
    await expect(transcribeBatchItem({ ...item(), asr_job_id: "cloud", part_count: 1 }, new AbortController().signal))
      .resolves.toEqual({ pending: true });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("saves a completed cloud task without depending on platform availability", async () => {
    mocks.readAsr.mockResolvedValue({
      id: "cloud", taskId: "provider", status: "running",
      historyContext: { historyRecordId: "history", work: { id: "BV1test:1", caption: "视频" } },
    });
    await expect(transcribeBatchItem({ ...item(), asr_job_id: "cloud", part_count: 1 }, new AbortController().signal))
      .resolves.toBe("转录结果");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("finishes fully checkpointed work without requiring upstream metadata or an API key", async () => {
    await expect(
      transcribeBatchItem(
        {
          ...item(),
          part_count: 1,
          completed_parts: [
            { workId: "BV1test:1", title: "视频", text: "已保存" },
          ],
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("已保存");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("reuses a persisted successful provider result without downloading audio or submitting again", async () => {
    mocks.readAsr.mockResolvedValue({
      id: "item:0:1",
      workKey: "bilibili:video:BV1test:1",
      status: "succeeded",
      result: result.result,
    });
    await expect(
      transcribeBatchItem(item(), new AbortController().signal),
    ).resolves.toBe("转录结果");
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ transcriptContent: "转录结果" }),
    );
  });
  it("resumes an accepted task even after an explicit batch retry changed the generation", async () => {
    mocks.readAsr.mockResolvedValue({
      id: "old-job",
      taskId: "provider",
      workKey: "bilibili:video:BV1test:1",
      status: "running",
    });
    await transcribeBatchItem(
      { ...item(), generation: 1, asr_job_id: "old-job" },
      new AbortController().signal,
    );
    expect(mocks.refresh).toHaveBeenCalledWith(
      "owner",
      "old-job",
      expect.anything(),
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("skips completed multipart results and transcribes only the remaining part", async () => {
    mocks.resolve.mockResolvedValueOnce({
      metadata: {
        bvid: "BV1test",
        authorAvatarUrls: [],
        coverUrls: [],
        authorName: "UP",
        pages: [
          { cid: 1, page: 1, part: "第一节", durationSeconds: 60 },
          { cid: 2, page: 2, part: "第二节", durationSeconds: 60 },
        ],
      },
    });
    const text = await transcribeBatchItem(
      {
        ...item(),
        completed_parts: [
          { workId: "BV1test:1", title: "第一节", text: "已完成" },
        ],
      },
      new AbortController().signal,
    );
    expect(text).toContain("已完成");
    expect(text).toContain("转录结果");
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(mocks.submit).toHaveBeenCalledWith(
      "owner",
      "bilibili:video:BV1test:2",
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ clientJobId: "item:0:2" }),
    );
  });
  it("reuses uploaded audio during a fresh recognition retry without downloading the video again", async () => {
    mocks.history.mockResolvedValueOnce({ record: { id: "history", originalAudio: "audio" } });
    mocks.cachedAudio.mockResolvedValueOnce({ objectKey: "audio", url: "https://oss/audio", durationSeconds: 60 });
    await transcribeBatchItem({ ...item(), generation: 8 }, new AbortController().signal);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.submit).toHaveBeenCalledWith("owner", expect.anything(), expect.anything(), { model: "qwen-audio-3.1-asr-flash-filetrans" },
      expect.objectContaining({ clientJobId: "item:8:1" }));
  });
  it("does not automatically resubmit a terminal failure", async () => {
    mocks.readAsr.mockResolvedValue({ id: "item:0:1", status: "failed" });
    mocks.refresh.mockResolvedValue({
      status: "failed",
      result: { ok: false, detail: "任务失败" },
    });
    await expect(
      transcribeBatchItem(item(), new AbortController().signal),
    ).rejects.toThrow("任务失败");
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("skips ambiguous submission without blocking the batch or risking duplicate billing", async () => {
    mocks.readAsr.mockResolvedValue({
      id: "item:0:1",
      taskId: "",
      status: "running",
    });
    await expect(
      transcribeBatchItem(item(), new AbortController().signal),
    ).resolves.toEqual({ skipped: expect.stringContaining("确认中断") });
    expect(mocks.markFailed).toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it.each([
    { ok: false, code: "no_speech", detail: "没有可识别语音" },
    { ok: false, code: "unavailable", detail: "音频不可用" },
    { ok: false, code: "error", detail: "无效音频", retryable: false },
    { ok: false, code: "error", detail: "提交确认中断", submissionUncertain: true, retryable: true },
  ])("skips terminal input or uncertain submission failures: $detail", async failure => {
    mocks.submit.mockResolvedValueOnce({ status: "failed", result: failure });
    await expect(transcribeBatchItem(item(), new AbortController().signal)).resolves.toEqual({ skipped: failure.detail });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.checkpoint).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      completedParts: [{ workId: "BV1test:1", title: "视频标题", text: "", skipped: failure.detail }],
    }));
  });
  it("keeps configuration failures actionable rather than skipping the whole batch", async () => {
    mocks.submit.mockResolvedValueOnce({ status: "failed", result: { ok: false, code: "not_configured", retryable: false, detail: "请配置 API Key" } });
    await expect(transcribeBatchItem(item(), new AbortController().signal)).rejects.toThrow("请配置 API Key");
  });
  it("skips undecodable audio without submitting it to the provider", async () => {
    mocks.prepare.mockRejectedValueOnce(new FfmpegProcessError("没有可用音轨", 1));
    await expect(transcribeBatchItem(item(), new AbortController().signal)).resolves.toEqual({ skipped: "没有可用音轨" });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("resumes a legacy no-speech pause without preparing audio or resubmitting", async () => {
    mocks.readAsr.mockResolvedValueOnce({ id: "silent", status: "failed", failure: { ok: false, code: "no_speech", detail: "没有人声" },
      historyContext: { historyRecordId: "history", work: { id: "BV1test:1", caption: "视频" } } });
    mocks.refresh.mockResolvedValueOnce({ status: "failed", result: { ok: false, code: "no_speech", detail: "没有人声" } });
    await expect(transcribeBatchItem({ ...item(), asr_job_id: "silent", part_count: 1 }, new AbortController().signal))
      .resolves.toEqual({ skipped: "没有人声" });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("continues other parts after silent audio and excludes skipped parts from the export", async () => {
    mocks.resolve.mockResolvedValueOnce({ metadata: { bvid: "BV1test", authorAvatarUrls: [], coverUrls: [], pages: [
      { cid: 1, page: 1, part: "静音", durationSeconds: 60 }, { cid: 2, page: 2, part: "有声", durationSeconds: 60 },
    ] } });
    mocks.submit.mockResolvedValueOnce({ status: "failed", result: { ok: false, code: "no_speech", detail: "没有人声" } });
    const text = await transcribeBatchItem(item(), new AbortController().signal);
    expect(text).toContain("转录结果");
    expect(text).not.toContain("静音");
    expect(text).not.toContain("没有人声");
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenCalledOnce();
  });
  it("finishes checkpointed skipped work without touching external services", async () => {
    await expect(transcribeBatchItem({ ...item(), part_count: 1, completed_parts: [
      { workId: "BV1test:1", title: "静音", text: "", skipped: "没有人声" },
    ] }, new AbortController().signal)).resolves.toEqual({ skipped: "没有人声" });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("keeps a running provider task available for retry after a transient polling failure", async () => {
    mocks.readAsr.mockResolvedValue({
      id: "item:0:1",
      taskId: "provider",
      status: "running",
    });
    mocks.refresh.mockResolvedValue({
      status: "failed",
      result: { ok: false, detail: "网络失败" },
    });
    await expect(
      transcribeBatchItem(item(), new AbortController().signal),
    ).rejects.toThrow("网络失败");
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
