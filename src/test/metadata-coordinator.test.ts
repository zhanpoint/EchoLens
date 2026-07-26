import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ collectWorkMetadata: vi.fn() }));

vi.mock("@/lib/douyin/detail", () => ({
  collectWorkMetadata: mocks.collectWorkMetadata,
}));

import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";

describe("work metadata coordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.collectWorkMetadata.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("deduplicates concurrent collection and clears original URLs after the final release", async () => {
    let finish: ((metadata: {
      authorAvatarUrls: string[];
      authorName: string;
      caption: string;
      coverUrls: string[];
      durationSeconds: number;
      videoUrls: string[];
    }) => void) | undefined;
    mocks.collectWorkMetadata.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const work = {
      finalUrl: "https://www.douyin.com/video/700001",
      id: "700001",
      kind: "video" as const,
    };

    const first = acquireWorkMetadata(work);
    const second = acquireWorkMetadata(work);
    expect(mocks.collectWorkMetadata).toHaveBeenCalledTimes(1);

    finish?.({
      authorAvatarUrls: ["https://origin/avatar"],
      authorName: "作者",
      caption: "作品标题",
      coverUrls: ["https://origin/cover"],
      durationSeconds: 60,
      videoUrls: ["https://origin/video"],
    });
    const [firstLease, secondLease] = await Promise.all([first, second]);
    expect(firstLease.metadata).toBe(secondLease.metadata);

    firstLease.release();
    expect(secondLease.metadata.videoUrls).toEqual(["https://origin/video"]);
    secondLease.release();
    expect(secondLease.metadata.videoUrls).toEqual(["https://origin/video"]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(secondLease.metadata).toMatchObject({
      authorAvatarUrls: undefined,
      coverUrls: undefined,
      videoUrls: undefined,
    });
  });

  it("evicts a failed collection so retry can start a new request", async () => {
    mocks.collectWorkMetadata
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({
        authorAvatarUrls: [],
        authorName: "重试成功",
        caption: "重试作品",
        coverUrls: [],
        durationSeconds: 1,
        videoUrls: [],
      });
    const work = {
      finalUrl: "https://www.douyin.com/video/700002",
      id: "700002",
      kind: "video" as const,
    };

    await expect(acquireWorkMetadata(work)).rejects.toThrow("temporary");
    const retry = await acquireWorkMetadata(work);
    expect(retry.metadata).toMatchObject({ authorName: "重试成功", caption: "重试作品" });
    retry.release();
    expect(mocks.collectWorkMetadata).toHaveBeenCalledTimes(2);
  });
});