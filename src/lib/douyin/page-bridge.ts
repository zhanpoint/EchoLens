import { createHash } from "node:crypto";
import { awaitWithSignal } from "@/lib/http/abort";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

const IDLE_MS = 120_000;
const MAX_SESSIONS = 4;
type Session = {
  controller: AbortController;
  ready: Promise<{ context: BrowserContext; page: Page }>;
  tail: Promise<void>;
  pending: number;
  timer?: ReturnType<typeof setTimeout>;
};
type State = { browser?: Promise<Browser>; sessions: Map<string, Session> };
const globals = globalThis as typeof globalThis & {
  __douyinPageBridge?: State;
};
const state: State = (globals.__douyinPageBridge ??= { sessions: new Map() });

export class DouyinPageBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DouyinPageBridgeError";
  }
}

export async function requestDouyinPage(input: {
  cookie: string;
  path: string;
  params: Record<string, string | number>;
  method?: "GET" | "POST";
  body?: Record<string, string | number>;
  signal?: AbortSignal;
  beforeDispatch?: () => Promise<void>;
}): Promise<Response> {
  input.signal?.throwIfAborted();
  if (
    !input.path.startsWith("/aweme/") ||
    input.path.includes("?") ||
    input.path.includes("#")
  )
    throw new Error("抖音页面请求路径无效。");
  // Credentials remain in memory in isolated browser contexts; never use a shared profile.
  const key = createHash("sha256").update(input.cookie).digest("hex");
  let session = state.sessions.get(key);
  if (!session) {
    if (state.sessions.size >= MAX_SESSIONS) {
      const idle = [...state.sessions].find(([, entry]) => entry.pending === 0);
      if (!idle)
        throw new DouyinPageBridgeError("抖音会话正在使用中，请稍后继续获取。");
      // Release the slot synchronously before another caller can reserve it.
      void dispose(idle[0], idle[1]);
    }
    const controller = new AbortController();
    session = {
      controller,
      ready: createSession(input.cookie, controller.signal),
      tail: Promise.resolve(),
      pending: 0,
    };
    state.sessions.set(key, session);
    const created = session;
    void created.ready.catch(() => dispose(key, created));
  }
  const entry = session;
  clearTimeout(entry.timer);
  entry.pending += 1;
  const previous = entry.tail;
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  entry.tail = previous.then(() => slot);
  let aborted = false;
  let active = false;
  let dispatchPolicyFailed = false;
  const abort = () => {
    aborted = true;
    void dispose(key, entry);
  };
  try {
    await awaitWithSignal(previous, input.signal);
    input.signal?.throwIfAborted();
    // An earlier cancellation/failure may have retired the queued session.
    // This request has not been dispatched yet and can acquire a fresh context.
    if (state.sessions.get(key) !== entry) return requestDouyinPage(input);
    active = true;
    input.signal?.addEventListener("abort", abort, { once: true });
    const { page } = await entry.ready;
    try {
      // Pace actual dispatches, not queue admission: otherwise a slow request
      // could build a backlog of already-approved calls that later burst together.
      await input.beforeDispatch?.();
    } catch (error) {
      dispatchPolicyFailed = true;
      throw error;
    }
    input.signal?.throwIfAborted();
    // Read the real network response through Playwright. SDK wrappers can leave
    // fetch/XHR promises pending even after an upstream empty response completes.
    const deadline = AbortSignal.timeout(20_000);
    const signal = input.signal
      ? AbortSignal.any([input.signal, deadline])
      : deadline;
    const response = page
      .waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.origin === "https://www.douyin.com" &&
          url.pathname === input.path &&
          response.request().method() === (input.method ?? "GET") &&
          (!input.body || Object.entries(input.body).every(([name, value]) =>
            new URLSearchParams(response.request().postData() ?? "").get(name) === String(value),
          )) &&
          Object.entries(input.params).every(
            ([name, value]) => url.searchParams.get(name) === String(value),
          )
        );
      }, { timeout: 20_000 })
      .then(async (response) => {
        const headers = await response.allHeaders();
        return {
          status: response.status(),
          text: headers["content-length"] === "0" ? "" : await response.text(),
          retryAfter: headers["retry-after"],
        };
      });
    void response.catch(() => undefined);
    const dispatch = page.evaluate(
      ({ path, params, method, body }) => {
        const query = new URLSearchParams(
          Object.entries(params).map(([name, value]) => [name, String(value)]),
        );
        // Dispatch through the page SDK, which maintains signatures and tokens.
        void window.fetch(`${path}?${query}`, {
          method: method || "GET",
          credentials: "include",
          ...(body
            ? {
                body: new URLSearchParams(
                  Object.entries(body).map(([name, value]) => [name, String(value)]),
                ),
                headers: { "content-type": "application/x-www-form-urlencoded" },
              }
            : {}),
        }).catch(() => undefined);
      },
      {
        path: input.path,
        params: input.params,
        method: input.method,
        body: input.body,
      },
    );
    const [, result] = await awaitWithSignal(Promise.all([dispatch, response]), signal);
    // Release unfinished SDK wrappers before another request can reuse this context.
    if (!result.text.trim()) await dispose(key, entry);
    return new Response(result.text, {
      status: result.status,
      headers: result.retryAfter
        ? { "retry-after": result.retryAfter }
        : undefined,
    });
  } catch (error) {
    if (!active && input.signal?.aborted) input.signal.throwIfAborted();
    if (dispatchPolicyFailed && !input.signal?.aborted) throw error;
    await dispose(key, entry);
    if (aborted) input.signal?.throwIfAborted();
    if (error instanceof DouyinPageBridgeError) throw error;
    // Playwright errors can contain request URLs. Keep credentials out of application logs/UI.
    throw new DouyinPageBridgeError(
      "抖音网页会话初始化或请求失败，请检查网络后继续；如果网页提示验证，请在浏览器完成验证并更新访问凭证。",
    );
  } finally {
    input.signal?.removeEventListener("abort", abort);
    entry.pending -= 1;
    release();
    if (entry.pending === 0 && input.signal?.aborted) void dispose(key, entry);
    if (entry.pending === 0 && state.sessions.get(key) === entry) {
      entry.timer = setTimeout(() => void dispose(key, entry), IDLE_MS);
      entry.timer.unref();
    }
  }
}

async function createSession(
  cookie: string,
  signal: AbortSignal,
) {
  const browser = await getBrowser();
  signal.throwIfAborted();
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1536, height: 864 },
    serviceWorkers: "block",
  });
  const abort = () => {
    void context.close().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await context.addCookies(
      cookie.split(";").flatMap((part) => {
        const index = part.indexOf("=");
        if (index <= 0) return [];
        return [
          {
            name: part.slice(0, index).trim(),
            value: part.slice(index + 1).trim(),
            domain: ".douyin.com",
            path: "/",
          },
        ];
      }),
    );
    const page = await context.newPage();
    await page.route("**/*", (route) =>
      ["image", "media", "font"].includes(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );
    // Observe actual SDK readiness, not a fixed sleep or the page's perpetual network activity.
    const signedRequest = page.waitForRequest(
      (request) => {
        const url = new URL(request.url());
        return (
          url.origin === "https://www.douyin.com" &&
          url.pathname.startsWith("/aweme/") &&
          url.searchParams.has("x-secsdk-web-signature")
        );
      },
      { timeout: 30_000 },
    );
    // Attach rejection handling before navigation can fail.
    void signedRequest.catch(() => undefined);
    // This authenticated entry emits protected requests; the public homepage may not.
    await page.goto("https://www.douyin.com/user/self", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await signedRequest;
    return { context, page };
  } catch {
    await context.close();
    throw new DouyinPageBridgeError(
      "抖音网页安全会话未就绪，请在浏览器确认能访问该主页、完成验证后更新访问凭证。",
    );
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function getBrowser(): Promise<Browser> {
  if (state.browser) return state.browser;
  const pending = chromium
    .launch({
      headless: true,
      ...(process.env.DOUYIN_BROWSER_EXECUTABLE
        ? { executablePath: process.env.DOUYIN_BROWSER_EXECUTABLE }
        : process.platform === "win32"
          ? { channel: "msedge" }
          : {}),
    })
    .then((browser) => {
      browser.on("disconnected", () => {
        if (state.browser === pending) state.browser = undefined;
      });
      return browser;
    })
    .catch(() => {
      if (state.browser === pending) state.browser = undefined;
      throw new DouyinPageBridgeError(
        "抖音作品采集需要浏览器运行时。Windows 请安装 Edge；其他环境请运行 npx playwright install chromium，或配置 DOUYIN_BROWSER_EXECUTABLE。",
      );
    });
  state.browser = pending;
  return pending;
}

async function dispose(key: string, entry: Session) {
  if (state.sessions.get(key) !== entry) return;
  state.sessions.delete(key);
  clearTimeout(entry.timer);
  entry.controller.abort();
  await entry.ready
    .then(({ context }) => context.close())
    .catch(() => undefined);
  if (state.sessions.size === 0 && state.browser) {
    const pending = state.browser;
    state.browser = undefined;
    await pending.then((browser) => browser.close()).catch(() => undefined);
  }
}
