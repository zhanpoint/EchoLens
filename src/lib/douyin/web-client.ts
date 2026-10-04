import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { exponentialRetryDelay } from "@/lib/http/retry";
import {
  openApiPlatformRequestPolicy,
  OpenApiPlatformCooldownError,
  type OpenApiPlatformRequestPolicy,
} from "@/lib/open-api/platform-request-policy";
import { DouyinPageBridgeError, requestDouyinPage } from "./page-bridge";

type RequestOptions = {
  body?: Record<string, string | number>;
  method?: "GET" | "POST";
  signal?: AbortSignal;
};
export type DouyinClientOptions = {
  signal?: AbortSignal;
  requestPolicy?: OpenApiPlatformRequestPolicy;
};

export const DOUYIN_BASE_URL = "https://www.douyin.com";

export class DouyinApiError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_COOKIE"
      | "LOGIN_REQUIRED"
      | "ACCESS_BLOCKED"
      | "RATE_LIMITED"
      | "ANTI_BOT"
      | "BROWSER_SESSION_UNAVAILABLE"
      | "UPSTREAM_ERROR",
    readonly details?: {
      endpoint?: string;
      status?: number;
      upstreamCode?: number;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "DouyinApiError";
  }
}

export function isDouyinCredentialError(
  error: unknown,
): error is DouyinApiError & { code: "INVALID_COOKIE" | "LOGIN_REQUIRED" } {
  return (
    error instanceof DouyinApiError &&
    (error.code === "INVALID_COOKIE" || error.code === "LOGIN_REQUIRED")
  );
}

export type DouyinWebClient = {
  getSelfProfile(attempts?: number): Promise<Record<string, unknown>>;
  query(): Record<string, string>;
  request(
    path: string,
    params: Record<string, string | number>,
    attempts?: number,
    options?: RequestOptions,
  ): Promise<Record<string, unknown>>;
  verifyAuthenticatedSession(attempts?: number): Promise<void>;
};

export function createDouyinWebClient(
  value: string,
  options: DouyinClientOptions = {},
): DouyinWebClient {
  const cookie = normalizeCookie(value);
  const hasLogin = cookie.split(";").some((part) => {
    const index = part.indexOf("=");
    return (
      index > 0 &&
      ["sessionid", "sessionid_ss", "sid_guard", "sid_tt"].includes(part.slice(0, index).trim()) &&
      Boolean(part.slice(index + 1).trim())
    );
  });
  if (!hasLogin) {
    throw new DouyinApiError("访问凭证不完整，请重新获取。", "INVALID_COOKIE");
  }
  // Sharing a credential also shares its cooldown across all authenticated features.
  const policy = options.requestPolicy ??
    openApiPlatformRequestPolicy.forUser(
      `douyin-credential:${createHash("sha256").update(cookie).digest("hex")}`,
    );

  async function request(
    path: string,
    params: Record<string, string | number>,
    attempts = 3,
    requestOptions: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const signal = options.signal && requestOptions.signal
      ? AbortSignal.any([options.signal, requestOptions.signal])
      : requestOptions.signal ?? options.signal;
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const response = await requestDouyinPage({
          cookie, path, params, ...requestOptions, signal,
          beforeDispatch: () => policy.beforeRequest("douyin", signal),
        });
        policy.observeResponse("douyin", response);
        const text = await response.text();
        if (response.status === 403 || response.status === 429) {
          throw new DouyinApiError(
            "抖音暂时限制访问，请稍后重试。",
            response.status === 429 ? "RATE_LIMITED" : "ACCESS_BLOCKED",
            { endpoint: path, status: response.status },
          );
        }
        if (!text.trim() && response.status < 500) {
          throw new DouyinApiError(
            "抖音返回空响应，请在浏览器完成验证后继续；无需重复保存凭证。",
            "ANTI_BOT", { endpoint: path, status: response.status },
          );
        }
        if (response.status >= 500) {
          if (attempt < attempts) {
            await delay(exponentialRetryDelay(attempt, 500, 5_000), undefined, { signal });
            continue;
          }
          throw new DouyinApiError(
            "抖音接口暂时不可用，请稍后重试。",
            "UPSTREAM_ERROR",
            { endpoint: path, status: response.status },
          );
        }
        const payload = parseJson(text);
        if (payload) policy.observePayload("douyin", payload);
        const upstreamCode = payload ? readNumber(payload.status_code) : undefined;
        if (payload && (
          upstreamCode === 2483 ||
          /请先登录|用户未登录/u.test(String(payload.status_msg ?? ""))
        )) {
          throw new DouyinApiError(
            "访问凭证已失效，请重新获取。", "LOGIN_REQUIRED",
            { endpoint: path, status: response.status, upstreamCode },
          );
        }
        if (!response.ok || !payload || (upstreamCode !== undefined && upstreamCode !== 0)) {
          throw new DouyinApiError(
            "抖音接口响应异常，请稍后重试。", "UPSTREAM_ERROR",
            { endpoint: path, status: response.status, upstreamCode },
          );
        }
        return payload;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof OpenApiPlatformCooldownError) {
          throw new DouyinApiError(
            "抖音暂时限制访问，请稍后继续；无需重复保存凭证。", "RATE_LIMITED",
            { endpoint: path, retryAfterSeconds: error.retryAfterSeconds },
          );
        }
        if (error instanceof DouyinPageBridgeError) {
          throw new DouyinApiError(error.message, "BROWSER_SESSION_UNAVAILABLE", { endpoint: path });
        }
        throw error;
      }
    }
  }

  function query(): Record<string, string> {
    return { device_platform: "webapp", aid: "6383", channel: "channel_pc_web" };
  }
  async function getSelfProfile(attempts = 3): Promise<Record<string, unknown>> {
    const payload = await request("/aweme/v1/web/user/profile/self/", query(), attempts);
    return readRecord(payload.user) ?? {};
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

function readNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function parseJson(value: string): Record<string, unknown> | null {
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
