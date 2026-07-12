import { readUserSettings, upsertUserSetting } from "@/lib/user-settings";
import { createDouyinWebClient, DouyinApiError, normalizeCookie } from "./web-client";

type StoredDouyinSettings = {
  credentialCheckedAt?: unknown;
  credentialStatus?: unknown;
  cookie?: unknown;
};

export type DouyinCredentialStatus = "invalid" | "missing" | "unknown" | "valid";

export type DouyinCredentialState = {
  checkedAt: number | null;
  cookie: string;
  status: DouyinCredentialStatus;
};

export async function readDouyinCredentialState(userId: string): Promise<DouyinCredentialState> {
  const settings = await readUserSettings(userId);
  const douyin = settings.douyin && typeof settings.douyin === "object"
    ? settings.douyin as StoredDouyinSettings
    : {};
  const cookie = typeof douyin.cookie === "string" ? normalizeCookie(douyin.cookie) : "";
  if (!cookie) {
    return { checkedAt: null, cookie: "", status: "missing" };
  }
  const status = douyin.credentialStatus === "valid" || douyin.credentialStatus === "invalid"
    ? douyin.credentialStatus
    : "unknown";
  const checkedAt = typeof douyin.credentialCheckedAt === "number" && Number.isFinite(douyin.credentialCheckedAt)
    ? douyin.credentialCheckedAt
    : null;
  return { checkedAt, cookie, status };
}

export async function validateDouyinCredential(cookie: string): Promise<void> {
  const self = await createDouyinWebClient(cookie).getSelfProfile(1);
  if (typeof (self.sec_uid ?? self.secUid) !== "string" || !(self.sec_uid ?? self.secUid)) {
    throw new DouyinApiError("访问凭证无效或已过期，请重新获取。", "LOGIN_REQUIRED");
  }
}

export async function validateAndStoreDouyinCredential(userId: string, cookie: string): Promise<DouyinCredentialState> {
  const normalized = normalizeCookie(cookie);
  if (!normalized) {
    const state = { checkedAt: null, cookie: "", status: "missing" } as const;
    await writeDouyinCredentialState(userId, state);
    return state;
  }
  try {
    await validateDouyinCredential(normalized);
    const state = { checkedAt: Date.now(), cookie: normalized, status: "valid" } as const;
    await writeDouyinCredentialState(userId, state);
    return state;
  } catch (error) {
    if (error instanceof DouyinApiError && error.code !== "UPSTREAM_ERROR") {
      await writeDouyinCredentialState(userId, {
        checkedAt: Date.now(),
        cookie: normalized,
        status: "invalid",
      });
    }
    throw error;
  }
}

export async function markDouyinCredentialInvalid(userId: string): Promise<void> {
  const state = await readDouyinCredentialState(userId);
  if (!state.cookie) {
    return;
  }
  await writeDouyinCredentialState(userId, {
    checkedAt: Date.now(),
    cookie: state.cookie,
    status: "invalid",
  });
}

async function writeDouyinCredentialState(userId: string, state: DouyinCredentialState): Promise<void> {
  await upsertUserSetting(userId, "douyin", {
    cookie: state.cookie,
    credentialCheckedAt: state.checkedAt,
    credentialStatus: state.status,
  });
}
