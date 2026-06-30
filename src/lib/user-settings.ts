import { getAuthDb } from "@/lib/auth/db";

export type UserSettingsCategory = "transcript" | "translation";

type UserSettingRow = {
  category: string;
  value_json: string;
};

const USER_SETTINGS_CATEGORIES = new Set<UserSettingsCategory>(["transcript", "translation"]);

export function isUserSettingsCategory(value: string): value is UserSettingsCategory {
  return USER_SETTINGS_CATEGORIES.has(value as UserSettingsCategory);
}

export function readUserSettings(userId: string): Partial<Record<UserSettingsCategory, unknown>> {
  const rows = getAuthDb()
    .prepare("SELECT category, value_json FROM user_settings WHERE user_id = ?")
    .all(userId) as UserSettingRow[];

  const settings: Partial<Record<UserSettingsCategory, unknown>> = {};
  for (const row of rows) {
    if (!isUserSettingsCategory(row.category)) {
      continue;
    }

    try {
      settings[row.category] = JSON.parse(row.value_json) as unknown;
    } catch {
      // Ignore malformed legacy rows instead of failing the whole settings load.
    }
  }
  return settings;
}

export function upsertUserSetting(userId: string, category: UserSettingsCategory, value: unknown): void {
  getAuthDb()
    .prepare(
      `INSERT INTO user_settings (user_id, category, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, category)
       DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(userId, category, JSON.stringify(value), Date.now());
}
