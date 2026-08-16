import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBilibiliDashSelection: vi.fn(),
  prepareBilibiliSnapshotAsset: vi.fn(),
  readUserSetting: vi.fn(),
  resolveBilibiliWork: vi.fn(),
  updateTranscriptHistoryRecordMetadata: vi.fn(),
}));

vi.mock("@/app/api/auth/_shared", () => ({
  logServerError: vi.fn(),
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));
vi.mock("@/lib/bilibili/account", () => ({ readUsableBilibiliCookie: vi.fn(() => "") }));
vi.mock("@/lib/bilibili/client", () => ({
  buildBilibiliWorkId: vi.fn((bvid: string, cid: number) => `${bvid}:${cid}`),
  getBilibiliDashSelection: mocks.getBilibiliDashSelection,
  resolveBilibiliWork: mocks.resolveBilibiliWork,
}));
vi.mock("@/lib/user-settings", () => ({ readUserSetting: mocks.readUserSetting }));
vi.mock("@/lib/transcript/assets", () => ({
  prepareBilibiliSnapshotAsset: mocks.prepareBilibiliSnapshotAsset,
}));
vi.mock("@/lib/transcript/db", () => ({
  updateTranscriptHistoryRecordMetadata: mocks.updateTranscriptHistoryRecordMetadata,
}));

import { POST } from "../app/api/bilibili/prepare/route";

const metadata = {
  aid: 1,
  authorAvatarUrls: ["https://origin/avatar"],
  authorName: "作者",
  bvid: "BV1test",
  caption: "标题",
  cid: 2,
  coverUrls: ["https://origin/cover"],
  durationSeconds: 90,
  page: 1,
  pages: [],
};
const work = {
  ...metadata,
  finalUrl: "https://www.bilibili.com/video/BV1test",
  id: "BV1test:2",
  inputUrl: "https://www.bilibili.com/video/BV1test",
  kind: "video" as const,
  source: "bilibili" as const,
};
const selection = {
  audio: { bandwidth: 128000, id: 30280, urls: ["https://origin/audio"] },
  video: { bandwidth: 500000, codecId: 7, height: 720, id: 64, urls: ["https://origin/video"] },
};

describe("bilibili prepare route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readUserSetting.mockResolvedValue(undefined);
    mocks.resolveBilibiliWork.mockResolvedValue({ metadata, work });
    mocks.getBilibiliDashSelection.mockResolvedValue(selection);
    mocks.updateTranscriptHistoryRecordMetadata.mockResolvedValue({
      id: "history-1",
      workKey: "bilibili:video:BV1test:2",
    });
    mocks.prepareBilibiliSnapshotAsset.mockImplementation(async ({ assetKind }: { assetKind: string }) => ({
      assetKind,
      contentType: assetKind === "originalAudio" ? "audio/mp4" : assetKind === "video" ? "video/mp4" : "image/jpeg",
      durationSeconds: assetKind === "originalAudio" || assetKind === "video" ? 90 : undefined,
      historyRecordId: "history-1",
      objectKey: assetKind === "originalAudio" ? "echolens/media/video/BV1test:2/audio.m4a" : undefined,
      sizeBytes: assetKind === "originalAudio" ? 100 : 0,
      updatedAt: 1,
      url: assetKind === "originalAudio" ? "https://oss/audio" : `https://origin/${assetKind}`,
    }));
  });

  it("resolves metadata and DASH once, emits no dubbing, and stores only original audio", async () => {
    const response = await POST(new Request("https://echolens.example/api/bilibili/prepare", {
      body: JSON.stringify({
        finalUrl: work.finalUrl,
        historyRecordId: "history-1",
        id: work.id,
        kind: "video",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    const body = await response.text();

    expect(mocks.resolveBilibiliWork).toHaveBeenCalledTimes(1);
    expect(mocks.getBilibiliDashSelection).toHaveBeenCalledTimes(1);
    expect(mocks.updateTranscriptHistoryRecordMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.prepareBilibiliSnapshotAsset).toHaveBeenCalledTimes(4);
    expect(body).not.toContain('"type":"dubbing"');
    expect(body).toContain('"asset":"video"');
    expect(body).toContain('"asset":"originalAudio"');
    expect(body).toContain('"objectKey":"echolens/media/video/BV1test:2/audio.m4a"');
    expect(body).not.toContain('"objectKey":"bilibili:');
  });
});