import { describe, expect, it } from "vitest";
import {
  createOpenApiPlatformRequestPolicy,
  OpenApiPlatformCooldownError,
} from "@/lib/open-api/platform-request-policy";

describe("Open API platform request policy", () => {
  it("serializes all Douyin credentials through one platform schedule", async () => {
    let now = 0;
    const delays: number[] = [];
    const policy = createOpenApiPlatformRequestPolicy({
      now: () => now,
      random: () => 0,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    });
    const userA = policy.forUser("user-a");
    const userB = policy.forUser("user-b");

    await userA.beforeRequest("douyin");
    await userB.beforeRequest("douyin");

    expect(delays).toEqual([500]);
  });

  it("uses the Bilibili one-second interval plus jitter", async () => {
    let now = 0;
    const delays: number[] = [];
    const policy = createOpenApiPlatformRequestPolicy({
      now: () => now,
      random: () => 1,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    });
    const user = policy.forUser("user-a");

    await user.beforeRequest("bilibili");
    await user.beforeRequest("bilibili");

    expect(delays).toEqual([1_000, 2_000]);
  });

  it("pauses only the platform user that returned a risk response", async () => {
    const policy = createOpenApiPlatformRequestPolicy({ random: () => 0 });
    const userA = policy.forUser("user-a");
    const userB = policy.forUser("user-b");

    expect(() =>
      userA.observeResponse("bilibili", new Response(null, { status: 403 })),
    ).toThrow(OpenApiPlatformCooldownError);
    await expect(userA.beforeRequest("bilibili")).rejects.toBeInstanceOf(
      OpenApiPlatformCooldownError,
    );
    await expect(userB.beforeRequest("bilibili")).resolves.toBeUndefined();
  });

  it("treats explicit verification payloads as risk responses", () => {
    const user = createOpenApiPlatformRequestPolicy().forUser("user-a");

    expect(() =>
      user.observePayload("douyin", { status_code: 10000, status_msg: "风控" }),
    ).toThrow(OpenApiPlatformCooldownError);
  });
  it("does not interpret author verification metadata or captions as gateway errors", async () => {
    const user = createOpenApiPlatformRequestPolicy({
      random: () => 0,
    }).forUser("user-a");
    const payload = {
      status_code: 0,
      aweme_list: [
        {
          desc: "安全验证与验证码",
          author: {
            custom_verify: "verified creator",
            enterprise_verify_reason: "认证",
          },
        },
      ],
    };
    expect(() => user.observePayload("douyin", payload)).not.toThrow();
    expect(() =>
      user.observePayload("douyin", JSON.stringify(payload)),
    ).not.toThrow();
    await expect(user.beforeRequest("douyin")).resolves.toBeUndefined();
  });
  it("recognizes a root challenge ticket and HTTP rate limiting", () => {
    const policy = createOpenApiPlatformRequestPolicy();
    expect(() =>
      policy
        .forUser("ticket")
        .observePayload("douyin", {
          verify_ticket: "challenge",
          status_code: 0,
        }),
    ).toThrow(OpenApiPlatformCooldownError);
    expect(() =>
      policy
        .forUser("rate")
        .observeResponse("douyin", new Response(null, { status: 429 })),
    ).toThrow(OpenApiPlatformCooldownError);
  });
  it("cancels waiting requests without sending or blocking later requests", async () => {
    let finish!: () => void;
    let sleeping!: () => void;
    const started = new Promise<void>(resolve => { sleeping = resolve; });
    const manager = createOpenApiPlatformRequestPolicy({ now: () => 0, random: () => 0, sleep: () => new Promise(resolve => { finish = resolve; sleeping(); }) });
    const policy = manager.forUser("cancelled");
    await policy.beforeRequest("douyin");
    const controller = new AbortController();
    const pending = policy.beforeRequest("douyin", controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await started;
    controller.abort();
    await rejected;
    finish();
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(policy.beforeRequest("douyin", alreadyCancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
