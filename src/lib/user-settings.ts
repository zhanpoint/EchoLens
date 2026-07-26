import { execute, queryRows } from "@/lib/storage/postgres";
import { decryptSensitiveValue, encryptSensitiveValue, isEncryptedValue } from "@/lib/sensitive-data";

export type UserSettingsCategory = "aiCredential" | "aiModels" | "douyin" | "download" | "transcript" | "translation";

type UserSettingRow = {
  category: string;
  value: unknown;
};

type ReadUserSettingsOptions = {
  includeDouyin?: boolean;
};

const USER_SETTINGS_CATEGORIES = new Set<UserSettingsCategory>(["aiCredential", "aiModels", "douyin", "download", "transcript", "translation"]);

export function isUserSettingsCategory(value: string): value is UserSettingsCategory {
  return USER_SETTINGS_CATEGORIES.has(value as UserSettingsCategory);
}

export async function readUserSettings(
  userId: string,
  options: ReadUserSettingsOptions = {},
): Promise<Partial<Record<UserSettingsCategory, unknown>>> {
  const includeDouyin = options.includeDouyin ?? true;
  const rows = await queryRows<UserSettingRow>(
    includeDouyin
      ? "SELECT category, value FROM user_settings WHERE user_id = $1"
      : "SELECT category, value FROM user_settings WHERE user_id = $1 AND category <> 'douyin'",
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

export async function readUserSetting(userId: string, category: UserSettingsCategory): Promise<unknown> {
  const rows = await queryRows<UserSettingRow>(
    "SELECT category, value FROM user_settings WHERE user_id = $1 AND category = $2 LIMIT 1",
    [userId, category],
  );
  const row = rows[0];
  return row ? readSettingValue(userId, category, row.value) : undefined;
}

async function readSettingValue(userId: string, category: UserSettingsCategory, value: unknown): Promise<unknown> {
  if (!isSensitiveCategory(category) || !value || typeof value !== "object") {
    return value;
  }
  const stored = value as Record<string, unknown>;
  const field = category === "douyin" ? "cookie" : "apiKey";
  if (isEncryptedValue(stored[field])) {
    return { ...stored, [field]: decryptSensitiveValue(stored[field], `${userId}:${category}:${field}`) };
  }
  if (typeof stored[field] === "string" && stored[field]) {
    await upsertUserSetting(userId, category, stored);
  }
  return stored;
}

function protectSettingValue(userId: string, category: UserSettingsCategory, value: unknown): unknown {
  if (!isSensitiveCategory(category) || !value || typeof value !== "object") {
    return value;
  }
  const setting = value as Record<string, unknown>;
  const field = category === "douyin" ? "cookie" : "apiKey";
  return typeof setting[field] === "string" && setting[field]
    ? { ...setting, [field]: encryptSensitiveValue(setting[field], `${userId}:${category}:${field}`) }
    : setting;
}

function isSensitiveCategory(category: UserSettingsCategory): category is "aiCredential" | "douyin" {
  return category === "aiCredential" || category === "douyin";
}
