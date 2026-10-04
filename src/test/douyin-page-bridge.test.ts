import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  newContext: vi.fn(),
  contexts: [] as {
    close: ReturnType<typeof vi.fn>;
    addCookies: ReturnType<typeof vi.fn>;
    page: {
      evaluate: ReturnType<typeof vi.fn>;
      goto: ReturnType<typeof vi.fn>;
      waitForRequest: ReturnType<typeof vi.fn>;
      waitForResponse: ReturnType<typeof vi.fn>;
      route: ReturnType<typeof vi.fn>;
    };
  }[],
}));
vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));
type Globals = typeof globalThis & {
  __douyinPageBridge?: {
    sessions: Map<string, { timer?: ReturnType<typeof setTimeout> }>;
  };
};
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.contexts.length = 0;
  delete (globalThis as Globals).__douyinPageBridge;
  mocks.newContext.mockImplementation(async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        text: '{"status_code":0}',
        retryAfter: null,
      }),
      goto: vi.fn(),
      waitForRequest: vi.fn().mockResolvedValue({}),
      waitForResponse: vi.fn().mockResolvedValue({
        status: () => 200,
        allHeaders: async () => ({}),
        text: async () => '{"status_code":0}',
      }),
      route: vi.fn(),
    };
    const context = {
      close: vi.fn(),
      addCookies: vi.fn(),
      newPage: vi.fn().mockResolvedValue(page),
      page,
    };
    mocks.contexts.push(context);
    return context;
  });
  mocks.launch.mockResolvedValue({
    newContext: mocks.newContext,
    on: vi.fn(),
    close: vi.fn(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of (
    globalThis as Globals
  ).__douyinPageBridge?.sessions.values() || [])
    clearTimeout(s.timer);
  delete (globalThis as Globals).__douyinPageBridge;
});
const input = {
  cookie: "sessionid=private-value",
  path: "/aweme/v1/web/aweme/post/",
  params: { count: 18 },
};
describe("Douyin page SDK sessions", () => {
  it("reuses the browser but isolates different credentials and keeps cookies off disk", async () => {
    const { requestDouyinPage } = await import("@/lib/douyin/page-bridge");
    await requestDouyinPage(input);
    await requestDouyinPage({
      ...input,
      params: { count: 18, max_cursor: 22 },
    });
    await requestDouyinPage({ ...input, cookie: "sessionid=other-value" });
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(mocks.newContext).toHaveBeenCalledTimes(2);
    expect(mocks.contexts[0].page.goto).toHaveBeenCalledOnce();
    expect(mocks.contexts[0].page.evaluate).toHaveBeenCalledTimes(2);
    expect(mocks.contexts[0].addCookies).toHaveBeenCalledWith([
      {
        name: "sessionid",
        value: "private-value",
        domain: ".douyin.com",
        path: "/",
      },
    ]);
    expect(mocks.contexts[1].addCookies).toHaveBeenCalledWith([
      {
        name: "sessionid",
        value: "other-value",
        domain: ".douyin.com",
        path: "/",
      },
    ]);
  });
  it("serializes requests within a credential and releases the queue after cancellation", async () => {
    const { requestDouyinPage } = await import("@/lib/douyin/page-bridge");
    await requestDouyinPage(input);
    let finish!: (value: unknown) => void;
    mocks.contexts[0].page.evaluate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = requestDouyinPage(input);
    await vi.waitFor(() =>
      expect(mocks.contexts[0].page.evaluate).toHaveBeenCalledTimes(2),
    );
    const controller = new AbortController();
    const queued = requestDouyinPage({ ...input, signal: controller.signal });
    controller.abort();
    expect(mocks.contexts[0].close).not.toHaveBeenCalled();
    const rejected = expect(queued).rejects.toMatchObject({
      name: "AbortError",
    });
    finish({ status: 200, text: "{}", retryAfter: null });
    await first;
    await rejected;
    await requestDouyinPage(input);
    expect(mocks.contexts[0].page.evaluate).toHaveBeenCalledTimes(3);
  });
  it("limits contexts and evicts idle credentials before opening a new one", async () => {
    const { requestDouyinPage } = await import("@/lib/douyin/page-bridge");
    for (let i = 0; i < 5; i++)
      await requestDouyinPage({ ...input, cookie: "sessionid=" + i });
    expect((globalThis as Globals).__douyinPageBridge?.sessions.size).toBe(4);
    expect(mocks.contexts[0].close).toHaveBeenCalledOnce();
  });
  it("bounds a stalled SDK evaluation, closes the failed context, and permits a fresh request", async () => {
    const { requestDouyinPage } = await import("@/lib/douyin/page-bridge");
    await requestDouyinPage(input);
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
    mocks.contexts[0].page.evaluate.mockImplementationOnce(() => new Promise(() => {}));
    const pending = requestDouyinPage(input);
    const rejected = expect(pending).rejects.toThrow("会话初始化或请求失败");
    await vi.waitFor(() => expect(mocks.contexts[0].page.evaluate).toHaveBeenCalledTimes(2));
    timeout.abort(new DOMException("timeout", "TimeoutError"));
    await rejected;
    expect(mocks.contexts[0].close).toHaveBeenCalled();
    expect((globalThis as Globals).__douyinPageBridge?.sessions.size).toBe(0);
    await requestDouyinPage(input);
    expect(mocks.newContext).toHaveBeenCalledTimes(2);
  });
  it("recognizes a completed empty response without waiting for an unresolved SDK fetch", async () => {
    const { requestDouyinPage } = await import("@/lib/douyin/page-bridge");
    await requestDouyinPage(input);
    const text = vi.fn(() => new Promise(() => {}));
    mocks.contexts[0].page.waitForResponse.mockResolvedValueOnce({ status: () => 200, allHeaders: async () => ({ "content-length": "0" }), text });
    const response = await requestDouyinPage(input);
    expect(await response.text()).toBe("");
    expect(text).not.toHaveBeenCalled();
    expect(mocks.contexts[0].close).toHaveBeenCalled();
    expect((globalThis as Globals).__douyinPageBridge?.sessions.size).toBe(0);
  });
  it("moves undispatched queued work to a fresh session when an earlier request is cancelled", async () => {
    const { requestDouyinPage } = await import("@/lib/douyin/page-bridge");
    await requestDouyinPage(input);
    mocks.contexts[0].page.waitForResponse.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const first = requestDouyinPage({ ...input, signal: controller.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.contexts[0].page.evaluate).toHaveBeenCalledTimes(2));
    const queued = requestDouyinPage(input);
    controller.abort();
    await rejected;
    await expect(queued).resolves.toBeInstanceOf(Response);
    expect(mocks.newContext).toHaveBeenCalledTimes(2);
  });
  it("cancels a queued waiter promptly without letting later requests overtake the active one", async () => {
    const { requestDouyinPage } = await import("@/lib/douyin/page-bridge");
    await requestDouyinPage(input);
    let finish!: (value: unknown) => void;
    mocks.contexts[0].page.evaluate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = requestDouyinPage(input);
    await vi.waitFor(() => expect(mocks.contexts[0].page.evaluate).toHaveBeenCalledTimes(2));
    const controller = new AbortController();
    const second = requestDouyinPage({ ...input, signal: controller.signal });
    const rejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    const third = requestDouyinPage(input);
    await Promise.resolve();
    expect(mocks.contexts[0].page.evaluate).toHaveBeenCalledTimes(2);
    finish({ status: 200, text: "{}", retryAfter: null });
    await Promise.all([first, third]);
    expect(mocks.contexts[0].page.evaluate).toHaveBeenCalledTimes(3);
  });
  it("keeps the context limit when concurrent users replace idle credentials", async () => {
    const { requestDouyinPage } = await import("@/lib/douyin/page-bridge");
    for (let i = 0; i < 4; i++)
      await requestDouyinPage({ ...input, cookie: "sessionid=" + i });
    await Promise.all(
      [4, 5].map((i) =>
        requestDouyinPage({ ...input, cookie: "sessionid=" + i }),
      ),
    );
    expect((globalThis as Globals).__douyinPageBridge?.sessions.size).toBe(4);
    expect(mocks.contexts[0].close).toHaveBeenCalledOnce();
    expect(mocks.contexts[1].close).toHaveBeenCalledOnce();
  });
  it("fails closed with an actionable message and removes failed session state", async () => {
    const { requestDouyinPage } = await import("@/lib/douyin/page-bridge");
    mocks.launch.mockRejectedValueOnce(
      new Error("private-cookie-and-browser-path"),
    );
    await expect(requestDouyinPage(input)).rejects.toThrow("浏览器运行时");
    expect((globalThis as Globals).__douyinPageBridge?.sessions.size).toBe(0);
    await requestDouyinPage(input);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });
  it("rejects arbitrary URLs before launching a browser", async () => {
    const { requestDouyinPage } = await import("@/lib/douyin/page-bridge");
    await expect(
      requestDouyinPage({ ...input, path: "https://example.com" }),
    ).rejects.toThrow("路径无效");
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("applies pacing just before dispatch and propagates cooldown without retiring the session", async () => {
    const { requestDouyinPage } = await import("@/lib/douyin/page-bridge");
    await requestDouyinPage(input);
    const blocked = new Error("cooldown");
    const beforeDispatch = vi.fn(async () => { throw blocked; });
    await expect(requestDouyinPage({ ...input, beforeDispatch })).rejects.toBe(blocked);
    expect(mocks.contexts[0].page.evaluate).toHaveBeenCalledOnce();
    expect(mocks.contexts[0].close).not.toHaveBeenCalled();
    await requestDouyinPage(input);
    expect(mocks.newContext).toHaveBeenCalledOnce();
  });
});
