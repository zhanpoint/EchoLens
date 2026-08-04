import QRCode from "qrcode";
import { fetchWithRetry } from "@/lib/http/retry";
import { upsertUserSetting } from "@/lib/user-settings";
import { validateBilibiliCookie } from "./client";

const QR_CODE_GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const QR_CODE_POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_COOKIE_KEYS = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"] as const;

export type BilibiliCredentialStatus = "invalid" | "missing" | "valid";

export type BilibiliCredentialState = {
  checkedAt: number | null;
  cookie: string;
  status: BilibiliCredentialStatus;
  username?: string;
};

export type BilibiliQRCodeSession = {
  qrcodeKey: string;
  svg: string;
};

export type BilibiliQRCodePollResult =
  | { status: "confirmed"; state: BilibiliCredentialState }
  | { message: string; status: "expired" | "pending" | "scanned" };

export class BilibiliCredentialError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_COOKIE" | "LOGIN_REQUIRED" | "UPSTREAM_ERROR",
  ) {
    super(message);
    this.name = "BilibiliCredentialError";
  }
}

type StoredBilibiliSettings = {
  credentialStatus?: unknown;
  cookie?: unknown;
};

export function readUsableBilibiliCookie(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const setting = value as StoredBilibiliSettings;
  return setting.credentialStatus === "valid" && typeof setting.cookie === "string"
    ? normalizeBilibiliCookie(setting.cookie)
    : "";
}

export async function validateAndStoreBilibiliCredential(userId: string, value: string): Promise<BilibiliCredentialState> {
  const normalized = normalizeBilibiliCookie(value);
  if (!normalized) {
    const state = { checkedAt: null, cookie: "", status: "missing" } as const;
    await writeBilibiliCredentialState(userId, state);
    return state;
  }
  try {
    const username = await validateLoginCookie(normalized);
    const state = { checkedAt: Date.now(), cookie: normalized, status: "valid", ...(username ? { username } : {}) } as const;
    await writeBilibiliCredentialState(userId, state);
    return state;
  } catch (error) {
    if (error instanceof BilibiliCredentialError && error.code !== "UPSTREAM_ERROR") {
      await writeBilibiliCredentialState(userId, {
        checkedAt: Date.now(),
        cookie: normalized,
        status: "invalid",
      });
    }
    throw error;
  }
}

export async function generateBilibiliQRCode(): Promise<BilibiliQRCodeSession> {
  const url = new URL(QR_CODE_GENERATE_URL);
  url.searchParams.set("source", "main-fe-header");
  url.searchParams.set("go_url", "https://www.bilibili.com/");
  url.searchParams.set("web_location", "333.1007");
  const { payload } = await requestPassportPayload(url);
  const data = readRecord(payload.data);
  const loginUrl = readString(data?.url);
  const qrcodeKey = readString(data?.qrcode_key);
  if (!loginUrl || !qrcodeKey) {
    throw new BilibiliCredentialError("Bilibili 二维码生成响应异常。", "UPSTREAM_ERROR");
  }
  return {
    qrcodeKey,
    svg: await QRCode.toString(loginUrl, { margin: 1, type: "svg", width: 192 }),
  };
}

export async function pollBilibiliQRCode(userId: string, qrcodeKey: string): Promise<BilibiliQRCodePollResult> {
  const key = qrcodeKey.trim();
  if (!key) {
    throw new BilibiliCredentialError("Bilibili 二维码参数无效。", "INVALID_COOKIE");
  }
  const url = new URL(QR_CODE_POLL_URL);
  url.searchParams.set("qrcode_key", key);
  const { cookies, payload } = await requestPassportPayload(url);
  const data = readRecord(payload.data);
  const code = typeof data?.code === "number" ? data.code : undefined;
  const message = readString(data?.message) ?? readString(payload.message) ?? "等待扫码确认。";
  if (code === 0) {
    const cookie = normalizeBilibiliCookie(cookiesToHeader(cookies));
    if (!cookie) {
      throw new BilibiliCredentialError("Bilibili 登录成功但未返回有效 Cookie。", "UPSTREAM_ERROR");
    }
    return { status: "confirmed", state: await validateAndStoreBilibiliCredential(userId, cookie) };
  }
  if (code === 86090) return { message, status: "scanned" };
  if (code === 86101) return { message, status: "pending" };
  if (code === 86038) return { message: "二维码已过期，请重新生成。", status: "expired" };
  throw new BilibiliCredentialError(message, "UPSTREAM_ERROR");
}

export function normalizeBilibiliCookie(value: string): string {
  const entries = parseCookieText(value);
  const ordered = [
    ...LOGIN_COOKIE_KEYS.flatMap((key) => entries[key] ? [[key, entries[key]] as const] : []),
    ...Object.entries(entries).filter(([key]) => !LOGIN_COOKIE_KEYS.includes(key as typeof LOGIN_COOKIE_KEYS[number])),
  ];
  return ordered.map(([key, cookieValue]) => `${key}=${cookieValue}`).join("; ");
}

async function validateLoginCookie(cookie: string): Promise<string | undefined> {
  if (!parseCookieText(cookie).SESSDATA) {
    throw new BilibiliCredentialError("Bilibili Cookie 缺少 SESSDATA，请重新获取完整登录 Cookie。", "INVALID_COOKIE");
  }
  try {
    const status = await validateBilibiliCookie(cookie);
    if (!status.isLogin) {
      throw new BilibiliCredentialError("Bilibili Cookie 未登录或已过期。", "LOGIN_REQUIRED");
    }
    return status.username;
  } catch (error) {
    if (error instanceof BilibiliCredentialError) throw error;
    throw new BilibiliCredentialError("Bilibili Cookie 验证失败，请稍后重试。", "UPSTREAM_ERROR");
  }
}

async function writeBilibiliCredentialState(userId: string, state: BilibiliCredentialState): Promise<void> {
  await upsertUserSetting(userId, "bilibili", {
    cookie: state.cookie,
    credentialCheckedAt: state.checkedAt,
    credentialStatus: state.status,
    ...(state.username ? { username: state.username } : {}),
  });
}

function parseCookieText(value: string): Record<string, string> {
  const text = value.trim().replace(/^cookie\s*:/iu, "").trim();
  if (!text) return {};
  const jsonCookies = parseJsonCookies(text);
  if (jsonCookies) return jsonCookies;
  const cookies: Record<string, string> = {};
  for (const part of text.replace(/\r?\n/gu, ";").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const cookieValue = part.slice(index + 1).trim().replace(/^"|"$/gu, "");
    if (key && cookieValue && !/\s/u.test(key)) {
      cookies[key] = cookieValue;
    }
  }
  return cookies;
}

function parseJsonCookies(value: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, cookieValue]) => (
        typeof key === "string" && typeof cookieValue === "string" && cookieValue
          ? [[key, cookieValue]]
          : []
      )),
    );
  } catch {
    return null;
  }
}

async function requestPassportPayload(url: URL): Promise<{ cookies: Record<string, string>; payload: Record<string, unknown> }> {
  const response = await fetchWithRetry(url.toString(), {
    cache: "no-store",
    headers: {
      accept: "application/json,text/plain,*/*",
      referer: "https://www.bilibili.com/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    retry: { timeoutMs: REQUEST_TIMEOUT_MS },
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !payload) {
    throw new BilibiliCredentialError(`Bilibili 登录接口请求失败：HTTP ${response.status}`, "UPSTREAM_ERROR");
  }
  if (payload.code !== 0) {
    throw new BilibiliCredentialError(readString(payload.message) ?? "Bilibili 登录接口返回错误。", "UPSTREAM_ERROR");
  }
  return { cookies: readSetCookies(response.headers), payload };
}

function readSetCookies(headers: Headers): Record<string, string> {
  const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? splitCombinedSetCookie(headers.get("set-cookie") ?? "");
  const cookies: Record<string, string> = {};
  for (const value of values) {
    const [pair] = value.split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const cookieValue = pair.slice(index + 1).trim();
    if (LOGIN_COOKIE_KEYS.includes(key as typeof LOGIN_COOKIE_KEYS[number]) && cookieValue) {
      cookies[key] = cookieValue;
    }
  }
  return cookies;
}

function splitCombinedSetCookie(value: string): string[] {
  return value ? value.split(/,(?=\s*[^;,\s]+=)/u).map((part) => part.trim()).filter(Boolean) : [];
}

function cookiesToHeader(cookies: Record<string, string>): string {
  return LOGIN_COOKIE_KEYS.flatMap((key) => cookies[key] ? [`${key}=${cookies[key]}`] : []).join("; ");
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}