import { execute, queryRows } from "@/lib/storage/postgres";

export type UserSettingsCategory = "transcript" | "translation";

type UserSettingRow = {
  category: string;
  value: unknown;
};

const USER_SETTINGS_CATEGORIES = new Set<UserSettingsCategory>(["transcript", "translation"]);

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
    settings[row.category] = row.value;
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
    [userId, category, JSON.stringify(value), Date.now()],
  );
}
