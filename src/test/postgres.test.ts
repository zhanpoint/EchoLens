import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closePostgresPoolForTest,
  ensurePostgresSchema,
  queryRow,
  setPostgresPoolForTest,
} from "@/lib/storage/postgres";
import { createPostgresTestPool } from "@/test/postgres-test-utils";

let pool: ReturnType<typeof createPostgresTestPool>;

beforeEach(async () => {
  pool = createPostgresTestPool();
  setPostgresPoolForTest(pool);
  await ensurePostgresSchema();
});

afterEach(async () => {
  await closePostgresPoolForTest();
});

describe("postgres storage", () => {
  it("creates the application schema before queries run", async () => {
    const row = await queryRow<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'`,
    );

    expect(row).toEqual({ table_name: "users" });
  });

  it("rebuilds legacy transcript data while preserving auth and Douyin credentials", async () => {
    await closePostgresPoolForTest();
    pool = createPostgresTestPool();
    setPostgresPoolForTest(pool);

    const now = new Date("2026-06-24T00:00:00.000Z");
    await pool.query(
      `CREATE TABLE users (
         id text PRIMARY KEY,
         username text NOT NULL,
         email text NOT NULL,
         password_hash text NOT NULL,
         terms_accepted_at timestamptz(3) NOT NULL,
         created_at timestamptz(3) NOT NULL,
         updated_at timestamptz(3) NOT NULL
       )`,
    );
    await pool.query(
      `CREATE TABLE user_settings (
         user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         category text NOT NULL,
         value jsonb NOT NULL,
         updated_at bigint NOT NULL,
         PRIMARY KEY (user_id, category)
       )`,
    );
    await pool.query(
      `INSERT INTO users (
         id, username, email, password_hash, terms_accepted_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $5, $5)`,
      ["user-1", "reader", "reader@example.com", "password-hash", now],
    );
    await pool.query(
      `INSERT INTO user_settings (user_id, category, value, updated_at)
       VALUES ($1, 'douyin', $2::jsonb, $3)`,
      ["user-1", JSON.stringify({ cookie: "encrypted-cookie" }), now.getTime()],
    );
    await pool.query(
      `CREATE TABLE transcript_history_records (
         id text NOT NULL,
         user_id text NOT NULL REFERENCES users(id),
         original_title text,
         display_title text
       )`,
    );
    await pool.query(
      `INSERT INTO transcript_history_records (id, user_id, original_title, display_title)
       VALUES ('legacy-history', 'user-1', '旧作品标题', '旧会话名称')`,
    );
    await pool.query("CREATE TABLE douyin_favorites_cache (user_id text PRIMARY KEY, payload jsonb)");

    await ensurePostgresSchema();
    await ensurePostgresSchema();

    await expect(pool.query("SELECT id FROM users WHERE id = 'user-1'"))
      .resolves.toMatchObject({ rows: [{ id: "user-1" }] });
    await expect(pool.query("SELECT category, value FROM user_settings WHERE user_id = 'user-1'"))
      .resolves.toMatchObject({ rows: [{ category: "douyin", value: { cookie: "encrypted-cookie" } }] });
    await expect(pool.query("SELECT id FROM transcript_history_records"))
      .resolves.toMatchObject({ rows: [] });

    const columns = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'transcript_history_records'`,
    ) as { rows: Array<{ column_name: string }> };
    const columnNames = columns.rows.map(({ column_name }) => column_name);
    expect(columnNames).toContain("caption");
    expect(columnNames).toContain("session_name");
    expect(columnNames).not.toContain("original_title");
    expect(columnNames).not.toContain("display_title");
    await expect(pool.query(
      "SELECT version FROM app_schema_migrations WHERE version = 'transcript-schema-v3-session-name'",
    )).resolves.toMatchObject({ rows: [{ version: "transcript-schema-v3-session-name" }] });
  });
});
