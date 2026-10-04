import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  readAsr: vi.fn(),
  refresh: vi.fn(),
  submit: vi.fn(),
  prepare: vi.fn(),
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
  getDashScopeAsrModel: (duration: number) => duration <= 300 ? "qwen-audio-3.1-asr-flash" : "qwen-audio-3.1-asr-flash-filetrans",
  submitDashScopeAsrJob: mocks.submit,
  refreshDashScopeAsrJobWithOptions: mocks.refresh,
}));
vi.mock("@/lib/transcript/assets", () => ({
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
  RetryableBatchError,
} from "@/lib/batch/transcribe";
import type { ClaimedItem } from "@/lib/batch/db";
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
  it("requires explicit recovery for ambiguous submission instead of silently risking duplicate billing", async () => {
    mocks.readAsr.mockResolvedValue({
      id: "item:0:1",
      taskId: "",
      status: "running",
    });
    await expect(
      transcribeBatchItem(item(), new AbortController().signal),
    ).rejects.toThrow("核对服务商");
    expect(mocks.markFailed).toHaveBeenCalled();
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
    ).rejects.toBeInstanceOf(RetryableBatchError);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
