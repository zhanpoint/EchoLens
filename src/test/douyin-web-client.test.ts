import { beforeEach, describe, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/douyin/page-bridge", () => ({
  requestDouyinPage: async (input: { beforeDispatch?: () => Promise<void> }) => {
    await input.beforeDispatch?.();
    return bridge(input);
  },
  DouyinPageBridgeError: class extends Error {},
}));
import { DouyinPageBridgeError } from "@/lib/douyin/page-bridge";
import { createDouyinWebClient } from "@/lib/douyin/web-client";
import { createOpenApiPlatformRequestPolicy, type OpenApiPlatformRequestPolicy } from "@/lib/open-api/platform-request-policy";

const policy = (): OpenApiPlatformRequestPolicy => ({ beforeRequest: vi.fn(), observeResponse: vi.fn(), observePayload: vi.fn() });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => bridge.mockReset());

describe("authenticated Douyin SDK client", () => {
  it.each([
    "/aweme/v1/web/user/profile/self/", "/aweme/v1/web/user/following/list/",
    "/aweme/v1/web/aweme/post/", "/aweme/v1/web/aweme/detail/",
    "/aweme/v1/web/aweme/listcollection/", "/aweme/v1/web/collects/list/",
    "/aweme/v1/web/collects/video/list/", "/aweme/v1/web/mix/listcollection/",
    "/aweme/v1/web/mix/aweme/", "/aweme/v1/web/comment/list/",
  ])("sends %s through the same SDK transport and policy", async (path) => {
    const requestPolicy = policy();
    const fetch = vi.spyOn(globalThis, "fetch");
    bridge.mockResolvedValue(json({ status_code: 0 }));
    const client = createDouyinWebClient("sessionid=session", { requestPolicy });
    await client.request(path, client.query());
    expect(bridge).toHaveBeenCalledOnce();
    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ path, cookie: "sessionid=session", params: { device_platform: "webapp", aid: "6383", channel: "channel_pc_web" } }));
    expect(fetch).not.toHaveBeenCalled();
    expect(requestPolicy.beforeRequest).toHaveBeenCalledOnce();
    expect(requestPolicy.observeResponse).toHaveBeenCalledOnce();
    expect(requestPolicy.observePayload).toHaveBeenCalledWith("douyin", { status_code: 0 });
    fetch.mockRestore();
  });
  it("preserves POST form bodies and the caller's cancellation", async () => {
    const controller = new AbortController();
    bridge.mockResolvedValue(json({ status_code: 0 }));
    const client = createDouyinWebClient("sessionid=session", { signal: controller.signal, requestPolicy: policy() });
    await client.request("/aweme/v1/web/aweme/listcollection/", client.query(), 1, { method: "POST", body: { count: 20, cursor: 100 } });
    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal, method: "POST", body: { count: 20, cursor: 100 } }));
    controller.abort();
    await expect(client.getSelfProfile()).rejects.toMatchObject({ name: "AbortError" });
    expect(bridge).toHaveBeenCalledOnce();
  });
  it.each([403, 429])("shares HTTP %s cooldown across features without retrying", async (status) => {
    const manager = createOpenApiPlatformRequestPolicy({ random: () => 0, now: () => 0, sleep: async () => {} });
    const requestPolicy = manager.forUser("same-credential");
    bridge.mockResolvedValue(new Response("blocked", { status }));
    await expect(createDouyinWebClient("sessionid=session", { requestPolicy }).getSelfProfile()).rejects.toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSeconds: 300 } });
    await expect(createDouyinWebClient("sessionid=session", { requestPolicy: manager.forUser("same-credential") }).request("/aweme/v1/web/aweme/post/", {})).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(bridge).toHaveBeenCalledOnce();
  });
  it("distinguishes explicit login failures from business and browser failures", async () => {
    const client = createDouyinWebClient("sessionid=session", { requestPolicy: policy() });
    bridge.mockResolvedValueOnce(json({ status_code: 2483, status_msg: "请先登录" }));
    await expect(client.getSelfProfile()).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
    bridge.mockResolvedValueOnce(json({ status_code: 1001, aweme_list: [] }));
    await expect(client.request("/aweme/v1/web/aweme/post/", {})).rejects.toMatchObject({ code: "UPSTREAM_ERROR", details: { upstreamCode: 1001 } });
    bridge.mockRejectedValueOnce(new DouyinPageBridgeError("browser unavailable"));
    await expect(client.getSelfProfile()).rejects.toMatchObject({ code: "BROWSER_SESSION_UNAVAILABLE" });
    expect(bridge).toHaveBeenCalledTimes(3);
  });
  it("bounds transient retries and stops retry delay when cancelled", async () => {
    bridge.mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(json({ status_code: 0, value: "ok" }));
    const controller = new AbortController();
    const client = createDouyinWebClient("sessionid=session", { signal: controller.signal, requestPolicy: policy() });
    await expect(client.request("/aweme/v1/web/aweme/detail/", {}, 2)).resolves.toMatchObject({ value: "ok" });
    expect(bridge).toHaveBeenCalledTimes(2);
    bridge.mockImplementationOnce(async () => { controller.abort(); return new Response(""); });
    await expect(client.getSelfProfile()).rejects.toMatchObject({ name: "AbortError" });
    expect(bridge).toHaveBeenCalledTimes(3);
  });
  it("rejects incomplete credentials before opening a session", () => {
    expect(() => createDouyinWebClient("msToken=token")).toThrow("凭证不完整");
    expect(bridge).not.toHaveBeenCalled();
  });
  it("does not retry a completed empty response or invalidate its credential", async () => {
    bridge.mockResolvedValue(new Response(""));
    const client = createDouyinWebClient("sessionid=session", { requestPolicy: policy() });
    await expect(client.request("/aweme/v1/web/comment/list/", {}, 3)).rejects.toMatchObject({ code: "ANTI_BOT" });
    expect(bridge).toHaveBeenCalledOnce();
  });
});
