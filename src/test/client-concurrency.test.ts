import { beforeEach, describe, expect, it } from "vitest";
import {
  resetClientRouteConcurrencyForTest,
  withClientRouteConcurrency,
} from "../lib/client-concurrency";

describe("client route concurrency", () => {
  beforeEach(() => {
    resetClientRouteConcurrencyForTest();
  });

  it("blocks concurrent requests to the same route from the same client", async () => {
    let release!: () => void;
    const request = new Request("https://echolens.dreamlog.xyz/api/douyin/extract", {
      headers: {
        cookie: "el_client=test-client-000000000000",
      },
    });
    const first = withClientRouteConcurrency(
      request,
      "douyin:extract",
      () => new Promise<Response>((resolve) => {
        release = () => resolve(new Response("ok"));
      }),
    );

    const blocked = await withClientRouteConcurrency(
      request,
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

  it("allows concurrent requests to different routes from the same client", async () => {
    let release!: () => void;
    const request = new Request("https://echolens.dreamlog.xyz/api/douyin/extract", {
      headers: {
        cookie: "el_client=test-client-000000000000",
      },
    });
    const first = withClientRouteConcurrency(
      request,
      "douyin:extract",
      () => new Promise<Response>((resolve) => {
        release = () => resolve(new Response("ok"));
      }),
    );

    const second = await withClientRouteConcurrency(
      request,
      "douyin:summarize",
      async () => new Response("ok"),
    );

    release();
    expect(second.status).toBe(200);
    expect((await first).status).toBe(200);
  });
});
