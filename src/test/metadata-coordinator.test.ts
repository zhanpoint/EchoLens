import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ collectWorkMetadata: vi.fn() }));

vi.mock("@/lib/douyin/detail", () => ({
  collectWorkMetadata: mocks.collectWorkMetadata,
}));

import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";
import type { OpenApiPlatformRequestPolicy } from "@/lib/open-api/platform-request-policy";

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

  it("shares work only within the same credential and request policy", async () => {
    mocks.collectWorkMetadata.mockImplementation(async (_work, options) => ({
      authorAvatarUrls: [], authorName: options.credentialCookie,
      caption: "作品", coverUrls: [], durationSeconds: 1, videoUrls: [],
    }));
    const work = { finalUrl: "https://www.douyin.com/video/700003", id: "700003", kind: "video" as const };
    const policy = (): OpenApiPlatformRequestPolicy => ({
      beforeRequest: vi.fn(), observePayload: vi.fn(), observeResponse: vi.fn(),
    });
    const firstPolicy = policy();
    const secondPolicy = policy();
    const leases = await Promise.all([
      acquireWorkMetadata(work, undefined, undefined, "sessionid=first"),
      acquireWorkMetadata(work, undefined, undefined, "sessionid=second"),
      acquireWorkMetadata(work, undefined, undefined, "sessionid=first"),
      acquireWorkMetadata(work, undefined, firstPolicy, "sessionid=first"),
      acquireWorkMetadata(work, undefined, secondPolicy, "sessionid=first"),
      acquireWorkMetadata(work, undefined, firstPolicy, "sessionid=first"),
    ]);
    try {
      expect(mocks.collectWorkMetadata).toHaveBeenCalledTimes(4);
      expect(leases[0].metadata).toBe(leases[2].metadata);
      expect(leases[0].metadata).not.toBe(leases[1].metadata);
      expect(leases[3].metadata).toBe(leases[5].metadata);
      expect(leases[3].metadata).not.toBe(leases[4].metadata);
      expect(leases[0].metadata.authorName).toBe("sessionid=first");
      expect(leases[1].metadata.authorName).toBe("sessionid=second");
    } finally {
      leases.forEach((lease) => lease.release());
      await vi.advanceTimersByTimeAsync(30_000);
    }
  });

  it("cancels one waiter independently and aborts upstream when the final waiter leaves", async () => {
    let upstream!: AbortSignal;
    mocks.collectWorkMetadata.mockImplementation((_work, options) => {
      upstream = options.signal;
      return new Promise(() => {});
    });
    const work = { finalUrl: "https://www.douyin.com/video/700004", id: "700004", kind: "video" as const };
    const first = new AbortController();
    const second = new AbortController();
    const a = acquireWorkMetadata(work, undefined, undefined, "", first.signal);
    const b = acquireWorkMetadata(work, undefined, undefined, "", second.signal);
    const aRejected = expect(a).rejects.toMatchObject({ name: "AbortError" });
    first.abort();
    await aRejected;
    expect(upstream.aborted).toBe(false);
    const bRejected = expect(b).rejects.toMatchObject({ name: "AbortError" });
    second.abort();
    await bRejected;
    expect(upstream.aborted).toBe(true);
    mocks.collectWorkMetadata.mockRejectedValueOnce(new Error("new operation"));
    await expect(acquireWorkMetadata(work)).rejects.toThrow("new operation");
    expect(mocks.collectWorkMetadata).toHaveBeenCalledTimes(2);
  });
});
