import { cleanText, readDouyinAvatarUrl } from "./media";
import { createDouyinWebClient, DOUYIN_BASE_URL, DouyinApiError } from "./web-client";

export type DouyinFollowingUser = {
  avatarUrl: string;
  id: string;
  name: string;
  signature: string;
  uniqueId: string;
  url: string;
};

const MAX_FOLLOWING_USERS = 5_000;

export async function collectDouyinFollowingUsers(cookie: string): Promise<DouyinFollowingUser[]> {
  const client = createDouyinWebClient(cookie);
  const self = await client.getSelfProfile();
  const secUid = readString(self.sec_uid ?? self.secUid);
  if (!secUid) {
    throw new DouyinApiError("访问凭证无效或已过期，请重新获取。", "LOGIN_REQUIRED");
  }

  const users: DouyinFollowingUser[] = [];
  const seen = new Set<string>();
  let maxTime = 0;

  while (users.length < MAX_FOLLOWING_USERS) {
    const payload = await client.request("/aweme/v1/web/user/following/list/", {
      ...client.query(),
      user_id: secUid,
      sec_user_id: secUid,
      offset: 0,
      count: 20,
      source_type: "1",
      gps_access: "0",
      address_book_access: "0",
      min_change: "0",
      ...(maxTime > 0 ? { max_time: maxTime } : {}),
    });
    const items = readArray(payload.followings ?? payload.follow_list ?? payload.user_list);
    for (const item of items) {
      const user = readRecord(readRecord(item).user ?? item);
      const id = readString(user.sec_uid ?? user.secUid ?? user.uid);
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      users.push({
        avatarUrl: readDouyinAvatarUrl(user),
        id,
        name: cleanText(readString(user.nickname) || readString(user.unique_id)) || "未命名用户",
        signature: cleanText(readString(user.signature)) || "",
        uniqueId: cleanText(readString(user.unique_id) || readString(user.short_id)) || "",
        url: new URL(`/user/${encodeURIComponent(id)}`, DOUYIN_BASE_URL).toString(),
      });
      if (users.length >= MAX_FOLLOWING_USERS) {
        break;
      }
    }

    const nextMaxTime = readInteger(payload.min_time);
    if (!readBoolean(payload.has_more) || items.length === 0 || nextMaxTime <= 0 || nextMaxTime === maxTime) {
      break;
    }
    maxTime = nextMaxTime;
  }

  return users;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function readBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : Number(value ?? 0) !== 0;
}
