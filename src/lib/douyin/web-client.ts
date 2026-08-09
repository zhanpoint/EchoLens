import { randomBytes } from "node:crypto";
import { fetchWithRetry } from "@/lib/http/retry";
import { signDouyinUrl } from "./xbogus";

export const DOUYIN_BASE_URL = "https://www.douyin.com";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;

export class DouyinApiError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_COOKIE" | "LOGIN_REQUIRED" | "ACCESS_BLOCKED" | "UPSTREAM_ERROR",
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
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    referer: "https://www.douyin.com/?recommend=1",
    "user-agent": DEFAULT_USER_AGENT,
  };
  if (cookie) {
    headers.cookie = cookie;
  }

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
    const url = new URL(path, DOUYIN_BASE_URL);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const signed = signDouyinUrl(url.toString(), DEFAULT_USER_AGENT);
    const requestHeaders = {
      ...headers,
      ...(options?.referer ? { referer: options.referer } : {}),
      ...(options?.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      "user-agent": signed.userAgent,
    };
    const response = await fetchWithRetry(signed.url, {
      body: options?.body ? new URLSearchParams(stringifyParams(options.body)).toString() : undefined,
      cache: "no-store",
      headers: requestHeaders,
      method: options?.method ?? "GET",
      retry: { attempts, retryHttpStatuses: [403], timeoutMs: REQUEST_TIMEOUT_MS },
    });
    const text = await response.text();
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
      throw new DouyinApiError(
        response.status === 403
          ? "抖音拒绝了当前收藏接口请求，通常是收藏接口路径、请求方法或短时 WAF 限速触发。请稍后重试。"
          : "抖音接口暂时不可用，请稍后重试。",
        response.status === 403 ? "ACCESS_BLOCKED" : "UPSTREAM_ERROR",
        {
          endpoint: path,
          status: response.status,
          upstreamCode,
        },
      );
    }
    if (!text.trim()) {
      throw new DouyinApiError("访问凭证无效或已触发抖音验证，请重新获取。", "LOGIN_REQUIRED", {
        endpoint: path,
        status: response.status,
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

  function query(): Record<string, string> {
    return {
      device_platform: "webapp",
      aid: "6383",
      channel: "channel_pc_web",
      update_version_code: "170400",
      pc_client_type: "1",
      pc_libra_divert: "Windows",
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
      msToken: cookieMap.msToken || randomBytes(136).toString("base64url"),
    };
  }

  return {
    async getSelfProfile(attempts = 3) {
      return readRecord((await request("/aweme/v1/web/user/profile/self/", query(), attempts)).user);
    },
    query,
    request,
  };
}

export function normalizeCookie(value: string): string {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("; ");
}

function stringifyParams(params: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]));
}

function parseCookie(cookie: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key && value) {
      entries[key] = value;
    }
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
  if (!payload) {
    return false;
  }
  const statusCode = Number(payload.status_code ?? 0);
  const message = String(payload.status_msg ?? "");
  const loginTip = payload.not_login_module;
  return statusCode === 2483 ||
    message.includes("请先登录") ||
    Boolean(loginTip && typeof loginTip === "object");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return readRecord(parsed, null);
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown>;
function readRecord(value: unknown, fallback: null): Record<string, unknown> | null;
function readRecord(value: unknown, fallback: Record<string, unknown> | null = {}): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : fallback;
}
