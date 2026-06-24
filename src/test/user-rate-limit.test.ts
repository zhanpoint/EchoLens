import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUserRateLimitsForTest, withUserRateLimit } from "../lib/user-rate-limit";

describe("user rate limit", () => {
  beforeEach(() => {
    resetUserRateLimitsForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T10:30:00+08:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("limits by user and route only", async () => {
    for (let index = 0; index < 50; index += 1) {
      const response = await withUserRateLimit("user-1", "douyin:extract", async () => new Response("ok"));
      expect(response.status).not.toBe(429);
    }

    const blocked = await withUserRateLimit("user-1", "douyin:extract", async () => new Response("unexpected"));
    const otherUser = await withUserRateLimit("user-2", "douyin:extract", async () => new Response("ok"));

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    await expect(blocked.json()).resolves.toMatchObject({
      error: "您已达到今日使用上限，请于明天 00:00 后继续使用。",
      retryAfter: expect.any(Number),
    });
    expect(otherUser.status).toBe(200);
  });

  it("uses separate daily quotas per route", async () => {
    for (let index = 0; index < 100; index += 1) {
      const response = await withUserRateLimit("user-1", "douyin:summarize", async () => new Response("ok"));
      expect(response.status).not.toBe(429);
    }

    const blocked = await withUserRateLimit("user-1", "douyin:summarize", async () => new Response("unexpected"));

    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({
      error: "您已达到今日使用上限，请于明天 00:00 后继续使用。",
      retryAfter: expect.any(Number),
    });
  });
});
