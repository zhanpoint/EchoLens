import { beforeEach, describe, expect, it } from "vitest";
import {
  resetUserRouteConcurrencyForTest,
  withUserRouteConcurrency,
} from "../lib/user-concurrency";

describe("user route concurrency", () => {
  beforeEach(() => {
    resetUserRouteConcurrencyForTest();
  });

  it("blocks concurrent requests to the same route from the same user", async () => {
    let release!: () => void;
    const first = withUserRouteConcurrency(
      "user-1",
      "douyin:extract",
      () => new Promise<Response>((resolve) => {
        release = () => resolve(new Response("ok"));
      }),
    );

    const blocked = await withUserRouteConcurrency(
      "user-1",
      "douyin:extract",
      async () => new Response("unexpected"),
    );

    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      code: "REQUEST_IN_PROGRESS",
      error: expect.stringContaining("处理中"),
    });

    release();
    expect((await first).status).toBe(200);
  });

  it("allows concurrent requests to different routes from the same user", async () => {
    let release!: () => void;
    const first = withUserRouteConcurrency(
      "user-1",
      "douyin:extract",
      () => new Promise<Response>((resolve) => {
        release = () => resolve(new Response("ok"));
      }),
    );

    const second = await withUserRouteConcurrency(
      "user-1",
      "douyin:summarize",
      async () => new Response("ok"),
    );

    release();
    expect(second.status).toBe(200);
    expect((await first).status).toBe(200);
  });

  it("allows concurrent requests to the same route from different users", async () => {
    let release!: () => void;
    const first = withUserRouteConcurrency(
      "user-1",
      "douyin:extract",
      () => new Promise<Response>((resolve) => {
        release = () => resolve(new Response("ok"));
      }),
    );

    const second = await withUserRouteConcurrency(
      "user-2",
      "douyin:extract",
      async () => new Response("ok"),
    );

    release();
    expect(second.status).toBe(200);
    expect((await first).status).toBe(200);
  });
});
