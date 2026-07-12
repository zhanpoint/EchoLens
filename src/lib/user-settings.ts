import { execute, queryRows } from "@/lib/storage/postgres";
import { decryptSensitiveValue, encryptSensitiveValue, isEncryptedValue } from "@/lib/sensitive-data";

export type UserSettingsCategory = "douyin" | "transcript" | "translation";

type UserSettingRow = {
  category: string;
  value: unknown;
};

const USER_SETTINGS_CATEGORIES = new Set<UserSettingsCategory>(["douyin", "transcript", "translation"]);

export function isUserSettingsCategory(value: string): value is UserSettingsCategory {
  return USER_SETTINGS_CATEGORIES.has(value as UserSettingsCategory);
}

export async function readUserSettings(userId: string): Promise<Partial<Record<UserSettingsCategory, unknown>>> {
  const rows = await queryRows<UserSettingRow>(
    "SELECT category, value FROM user_settings WHERE user_id = $1",
    [userId],
  );

  const settings: Partial<Record<UserSettingsCategory, unknown>> = {};
  for (const row of rows) {
    if (!isUserSettingsCategory(row.category)) {
      continue;
    }
    settings[row.category] = await readSettingValue(userId, row.category, row.value);
  }
  return settings;
}

export async function upsertUserSetting(
  userId: string,
  category: UserSettingsCategory,
  value: unknown,
): Promise<void> {
  await execute(
    `INSERT INTO user_settings (user_id, category, value, updated_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT(user_id, category)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [userId, category, JSON.stringify(protectSettingValue(userId, category, value)), Date.now()],
  );
}

async function readSettingValue(userId: string, category: UserSettingsCategory, value: unknown): Promise<unknown> {
  if (category !== "douyin" || !value || typeof value !== "object") {
    return value;
  }
  const stored = value as Record<string, unknown>;
  if (isEncryptedValue(stored.cookie)) {
    return { ...stored, cookie: decryptSensitiveValue(stored.cookie, `${userId}:douyin:cookie`) };
  }
  if (typeof stored.cookie === "string" && stored.cookie) {
    await upsertUserSetting(userId, category, stored);
  }
  return stored;
}

function protectSettingValue(userId: string, category: UserSettingsCategory, value: unknown): unknown {
  if (category !== "douyin" || !value || typeof value !== "object") {
    return value;
  }
  const setting = value as Record<string, unknown>;
  return typeof setting.cookie === "string" && setting.cookie
    ? { ...setting, cookie: encryptSensitiveValue(setting.cookie, `${userId}:douyin:cookie`) }
    : setting;
}
