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

    expect(() => userA.observeResponse("bilibili", new Response(null, { status: 403 })))
      .toThrow(OpenApiPlatformCooldownError);
    await expect(userA.beforeRequest("bilibili")).rejects.toBeInstanceOf(OpenApiPlatformCooldownError);
    await expect(userB.beforeRequest("bilibili")).resolves.toBeUndefined();
  });

  it("treats explicit verification payloads as risk responses", () => {
    const user = createOpenApiPlatformRequestPolicy().forUser("user-a");

    expect(() => user.observePayload("douyin", { status_code: 10000, status_msg: "风控" }))
      .toThrow(OpenApiPlatformCooldownError);
  });
});