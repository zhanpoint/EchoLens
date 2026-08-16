import { fetchWithRetry, exponentialRetryDelay } from "@/lib/http/retry";
import { signABogusUrl } from "./abogus";
import { resolveMsToken } from "./ms-token";
import { signDouyinUrl } from "./xbogus";

export const DOUYIN_BASE_URL = "https://www.douyin.com";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;

export class DouyinApiError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_COOKIE"
      | "LOGIN_REQUIRED"
      | "ACCESS_BLOCKED"
      | "RATE_LIMITED"
      | "ANTI_BOT"
      | "UPSTREAM_ERROR",
    readonly details?: {
      endpoint?: string;
      status?: number;
      upstreamCode?: number;
    },
  ) {
    super(message);
    this.name = "DouyinApiError";
  }
}

export type DouyinWebClient = {
  getSelfProfile(attempts?: number): Promise<Record<string, unknown>>;
  query(): Record<string, string>;
  request(
    path: string,
    params: Record<string, string | number>,
    attempts?: number,
    options?: {
      body?: Record<string, string | number>;
      method?: "GET" | "POST";
      referer?: string;
    },
  ): Promise<Record<string, unknown>>;
  verifyAuthenticatedSession(attempts?: number): Promise<void>;
};

export function createDouyinWebClient(value: string): DouyinWebClient {
  const cookie = normalizeCookie(value);
  const cookieMap = parseCookie(cookie);
  if (!cookie || !hasLoginCookie(cookieMap)) {
    throw new DouyinApiError("访问凭证不完整，请重新获取。", "INVALID_COOKIE");
  }
  return createWebClient(cookie, cookieMap);
}

function createWebClient(
  cookie: string,
  cookieMap: Record<string, string>,
): DouyinWebClient {
  const baseHeaders: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    referer: "https://www.douyin.com/?recommend=1",
    "user-agent": DEFAULT_USER_AGENT,
  };
  let msToken = cookieMap.msToken ?? "";

  async function request(
    path: string,
    params: Record<string, string | number>,
    attempts = 3,
    options?: {
      body?: Record<string, string | number>;
      method?: "GET" | "POST";
      referer?: string;
    },
  ): Promise<Record<string, unknown>> {
    msToken ||= await resolveMsToken("", DEFAULT_USER_AGENT);
    const requestParams = { ...params, msToken };
    const body = options?.body ? new URLSearchParams(stringifyParams(options.body)).toString() : "";
    let lastFailure: DouyinApiError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const unsignedUrl = buildUrl(path, requestParams);
      const signed = signRequest(unsignedUrl, body);
      let response: Response;
      try {
        response = await fetchWithRetry(signed.url, {
          body: body || undefined,
          cache: "no-store",
          headers: {
            ...baseHeaders,
            cookie: appendCookie(cookie, "msToken", msToken),
            ...(options?.referer ? { referer: options.referer } : {}),
            ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
            "user-agent": signed.userAgent,
          },
          method: options?.method ?? "GET",
          retry: {
            attempts: 1,
            retryNetworkErrors: false,
            retryOnDefaultHttpStatuses: false,
            timeoutMs: REQUEST_TIMEOUT_MS,
          },
        });
      } catch (error) {
        if (attempt >= attempts) throw error;
        await retryDelay(attempt);
        continue;
      }
      if (response.status === 403 || response.status === 429) {
        await response.body?.cancel();
        lastFailure = response.status === 403
          ? new DouyinApiError("抖音拒绝了当前请求，请稍后重试。", "ACCESS_BLOCKED", {
              endpoint: path,
              status: response.status,
            })
          : new DouyinApiError("抖音接口请求过于频繁，请稍后重试。", "RATE_LIMITED", {
              endpoint: path,
              status: response.status,
            });
        if (attempt < attempts) {
          await retryDelay(attempt);
          continue;
        }
        throw lastFailure;
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        lastFailure = new DouyinApiError("抖音接口暂时不可用，请稍后重试。", "UPSTREAM_ERROR", {
          endpoint: path,
          status: response.status,
        });
        if (attempt < attempts) {
          await retryDelay(attempt);
          continue;
        }
        throw lastFailure;
      }

      const text = await response.text();
      if (!text.trim()) {
        lastFailure = new DouyinApiError(
          "抖音返回空响应，当前请求触发了反爬验证，请稍后重试。",
          "ANTI_BOT",
          { endpoint: path, status: response.status },
        );
        if (attempt < attempts) {
          await retryDelay(attempt);
          continue;
        }
        throw lastFailure;
      }

      const payload = parseJson(text);
      if (!response.ok) {
        const upstreamCode = payload ? readNumber(payload.status_code) : undefined;
        if (isLoginRequired(payload)) {
          throw new DouyinApiError("访问凭证已失效，请重新获取。", "LOGIN_REQUIRED", {
            endpoint: path,
            status: response.status,
            upstreamCode,
          });
        }
        throw new DouyinApiError("抖音接口暂时不可用，请稍后重试。", "UPSTREAM_ERROR", {
          endpoint: path,
          status: response.status,
          upstreamCode,
        });
      }
      if (!payload) {
        throw new DouyinApiError("抖音响应格式异常。", "UPSTREAM_ERROR", {
          endpoint: path,
          status: response.status,
        });
      }
      if (isLoginRequired(payload)) {
        throw new DouyinApiError("访问凭证已失效，请重新获取。", "LOGIN_REQUIRED", {
          endpoint: path,
          status: response.status,
          upstreamCode: readNumber(payload.status_code),
        });
      }
      return payload;
    }

    throw lastFailure ?? new DouyinApiError("抖音接口暂时不可用，请稍后重试。", "UPSTREAM_ERROR");
  }

  function query(): Record<string, string> {
    return {
      device_platform: "webapp",
      aid: "6383",
      channel: "channel_pc_web",
      update_version_code: "170400",
      pc_client_type: "1",
      pc_libra_divert: "Windows",
      version_code: "290100",
      version_name: "29.1.0",
      cookie_enabled: "true",
      screen_width: "1536",
      screen_height: "864",
      browser_language: "zh-CN",
      browser_platform: "Win32",
      browser_name: "Chrome",
      browser_version: "139.0.0.0",
      browser_online: "true",
      engine_name: "Blink",
      engine_version: "139.0.0.0",
      os_name: "Windows",
      os_version: "10",
      cpu_core_num: "16",
      device_memory: "8",
      platform: "PC",
      downlink: "10",
      effective_type: "4g",
      round_trip_time: "200",
      support_h265: "1",
      support_dash: "1",
      uifid: "",
      msToken,
    };
  }

  async function getSelfProfile(attempts = 3): Promise<Record<string, unknown>> {
    return readRecord((await request("/aweme/v1/web/user/profile/self/", query(), attempts)).user);
  }

  return {
    getSelfProfile,
    query,
    request,
    async verifyAuthenticatedSession(attempts = 1) {
      const self = await getSelfProfile(attempts);
      const secUid = self.sec_uid ?? self.secUid;
      if (typeof secUid !== "string" || !secUid) {
        throw new DouyinApiError("访问凭证无效或已过期，请重新获取。", "LOGIN_REQUIRED");
      }
    },
  };
}

export function normalizeCookie(value: string): string {
  return value.split(";").map((part) => part.trim()).filter(Boolean).join("; ");
}

function signRequest(url: string, body: string): { url: string; userAgent: string } {
  try {
    return signABogusUrl(url, DEFAULT_USER_AGENT, body);
  } catch {
    return signDouyinUrl(url, DEFAULT_USER_AGENT);
  }
}

function buildUrl(path: string, params: Record<string, string | number>): string {
  const url = new URL(path, DOUYIN_BASE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

function appendCookie(cookie: string, key: string, value: string): string {
  return parseCookie(cookie)[key] ? cookie : `${cookie}; ${key}=${value}`;
}

function stringifyParams(params: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]));
}

function parseCookie(cookie: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key && value) entries[key] = value;
  }
  return entries;
}

function hasLoginCookie(cookies: Record<string, string>): boolean {
  return Boolean(cookies.sessionid || cookies.sessionid_ss || cookies.sid_guard || cookies.sid_tt);
}

function readNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isLoginRequired(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  const statusCode = Number(payload.status_code ?? 0);
  const message = String(payload.status_msg ?? "");
  return statusCode === 2483 || message.includes("请先登录") || message.includes("用户未登录");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    return readRecord(JSON.parse(value) as unknown, null);
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown>;
function readRecord(value: unknown, fallback: null): Record<string, unknown> | null;
function readRecord(
  value: unknown,
  fallback: Record<string, unknown> | null = {},
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : fallback;
}

async function retryDelay(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, exponentialRetryDelay(attempt, 500, 5_000)));
}