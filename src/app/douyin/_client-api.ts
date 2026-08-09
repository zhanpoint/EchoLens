import { NETWORK_RETRY_ERROR_MESSAGE } from "@/lib/http/retry";

export type CurrentUser = {
  email: string;
  id: string;
  username: string;
};

export type ApiError = {
  code?: string;
  error: string;
};

export class DouyinCredentialRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DouyinCredentialRequiredError";
  }
}

const inFlightRequests = new Map<string, Promise<unknown>>();
const currentUserCache: { expiresAt: number; value: CurrentUser | null } = { expiresAt: 0, value: null };
const CURRENT_USER_CACHE_TTL = 30_000;

export function requestOnce<T>(key: string, request: () => Promise<T>): Promise<T> {
  const existing = inFlightRequests.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  const pending = request().finally(() => {
    if (inFlightRequests.get(key) === pending) {
      inFlightRequests.delete(key);
    }
  });
  inFlightRequests.set(key, pending);
  return pending;
}

export function getApiError(payload: unknown): ApiError | undefined {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return undefined;
  }
  const error = (payload as { error?: unknown }).error;
  const code = (payload as { code?: unknown }).code;
  return typeof error === "string"
    ? { error, ...(typeof code === "string" ? { code } : {}) }
    : undefined;
}

export async function readJsonPayload(response: Response, fallback: string): Promise<unknown> {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("json")) {
    throw new Error(fallback);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("服务响应异常，请稍后重试。");
  }
}

export function requestCurrentUser(): Promise<CurrentUser> {
  if (currentUserCache.value && currentUserCache.expiresAt > Date.now()) {
    return Promise.resolve(currentUserCache.value);
  }
  return requestOnce("auth:current-user", async () => {
    const response = await fetch("/api/auth/me", { cache: "no-store" });
    const payload = await readJsonPayload(response, "登录状态读取失败。") as { user?: unknown };
    if (response.status === 401) {
      throw new Error("UNAUTHENTICATED");
    }
    if (!response.ok || !isCurrentUser(payload.user)) {
      throw new Error("登录状态读取失败。");
    }
    currentUserCache.value = payload.user;
    currentUserCache.expiresAt = Date.now() + CURRENT_USER_CACHE_TTL;
    return payload.user;
  });
}

export async function requireValidDouyinCredential(): Promise<void> {
  const response = await fetch("/api/douyin/credential/validate", { cache: "no-store" });
  const payload = await readJsonPayload(response, "抖音账号访问凭证状态读取失败。") as {
    message?: unknown;
    status?: unknown;
  };
  if (response.status === 401) {
    throw new Error("UNAUTHENTICATED");
  }
  if (!response.ok) {
    throw new Error(getApiError(payload)?.error || "抖音账号访问凭证状态读取失败。");
  }
  if (payload.status !== "valid") {
    throw new DouyinCredentialRequiredError(
      typeof payload.message === "string" ? payload.message : "请前往设置更新抖音账号访问凭证。",
    );
  }
}

function isCurrentUser(value: unknown): value is CurrentUser {
  if (!value || typeof value !== "object") {
    return false;
  }
  const user = value as Partial<CurrentUser>;
  return typeof user.email === "string" &&
    typeof user.id === "string" &&
    typeof user.username === "string";
}

export function readUserFacingError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  const message = error.message.trim();
  if (/^(Failed to fetch|NetworkError|Load failed|fetch failed)$/i.test(message)) {
    return NETWORK_RETRY_ERROR_MESSAGE;
  }
  return message.replaceAll("Cookie", "访问凭证") || fallback;
}
