import { Pool, types, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import { BATCH_SCHEMA_STATEMENTS } from "@/lib/batch/schema";

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
};

type PooledQueryable = Queryable & {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
};

type GlobalWithPostgres = typeof globalThis & {
  __echolensPostgresPool?: PooledQueryable;
  __echolensPostgresSchemaReady?: Promise<void>;
  __echolensPostgresSchemaVersion?: number;
};

const POSTGRES_SCHEMA_VERSION = 6;

const globalForPostgres = globalThis as GlobalWithPostgres;
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1184, (value) => Date.parse(value));

export type DbExecutor = Queryable;

export function toPostgresTimestamp(epochMilliseconds: number): Date {
  const timestamp = new Date(epochMilliseconds);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError("Invalid epoch timestamp.");
  }
  return timestamp;
}

export function getPostgresPool(): PooledQueryable {
  if (globalForPostgres.__echolensPostgresPool) {
    return globalForPostgres.__echolensPostgresPool;
  }

  const password = process.env.POSTGRES_PASSWORD;
  if (!password) {
    throw new Error("POSTGRES_PASSWORD is required.");
  }

  const config: PoolConfig = {
    database: process.env.POSTGRES_DB || "echolens",
    host: process.env.POSTGRES_HOST || "localhost",
    max: readPositiveIntegerEnv("POSTGRES_POOL_MAX", 10),
    password,
    port: readPositiveIntegerEnv("POSTGRES_PORT", 5432),
    user: process.env.POSTGRES_USER || "postgres",
  };
  if (readBooleanEnv("POSTGRES_SSL", false)) {
    config.ssl = { rejectUnauthorized: readBooleanEnv("POSTGRES_SSL_REJECT_UNAUTHORIZED", true) };
  }

  const pool = new Pool(config);
  globalForPostgres.__echolensPostgresPool = pool;
  return pool;
}

export async function queryRows<T extends QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
  executor?: DbExecutor,
): Promise<T[]> {
  const db = executor ?? await getReadyPostgresPool();
  const result = await db.query<T>(text, values);
  return result.rows;
}

export async function queryRow<T extends QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
  executor?: DbExecutor,
): Promise<T | undefined> {
  const rows = await queryRows<T>(text, values, executor);
  return rows[0];
}

export async function execute(
  text: string,
  values: readonly unknown[] = [],
  executor?: DbExecutor,
): Promise<number> {
  const db = executor ?? await getReadyPostgresPool();
  const result = await db.query(text, values);
  return result.rowCount ?? 0;
}

export async function withTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await getReadyPostgresPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function ensurePostgresSchema(): Promise<void> {
  if (
    !globalForPostgres.__echolensPostgresSchemaReady
    || globalForPostgres.__echolensPostgresSchemaVersion !== POSTGRES_SCHEMA_VERSION
  ) {
    globalForPostgres.__echolensPostgresSchemaVersion = POSTGRES_SCHEMA_VERSION;
    globalForPostgres.__echolensPostgresSchemaReady = migrateSchema(getPostgresPool()).catch((error) => {
      delete globalForPostgres.__echolensPostgresSchemaReady;
      delete globalForPostgres.__echolensPostgresSchemaVersion;
      throw error;
    });
  }
  await globalForPostgres.__echolensPostgresSchemaReady;
}

export async function closePostgresPool(): Promise<void> {
  await globalForPostgres.__echolensPostgresPool?.end();
  delete globalForPostgres.__echolensPostgresPool;
  delete globalForPostgres.__echolensPostgresSchemaReady;
  delete globalForPostgres.__echolensPostgresSchemaVersion;
}

export const closePostgresPoolForTest = closePostgresPool;

export function setPostgresPoolForTest(pool: PooledQueryable): void {
  globalForPostgres.__echolensPostgresPool = pool;
  delete globalForPostgres.__echolensPostgresSchemaReady;
  delete globalForPostgres.__echolensPostgresSchemaVersion;
}

async function getReadyPostgresPool(): Promise<PooledQueryable> {
  await ensurePostgresSchema();
  return getPostgresPool();
}

async function migrateSchema(db: PooledQueryable): Promise<void> {
  await dropLegacyAuthDisplayViews(db);
  await migrateLegacyAuthTimestamps(db);
  for (const statement of CORE_SCHEMA_STATEMENTS) {
    await db.query(statement);
  }
  await migrateTranscriptHistorySchema(db);
  await migrateTranscriptSchemaV4(db);
  await migrateBatchSchema(db);
}

async function migrateBatchSchema(db: PooledQueryable): Promise<void> {
  const migrations = [
    ["transcript-schema-v6-durable-batches", BATCH_SCHEMA_STATEMENTS],
    ["transcript-schema-v7-qwen-audio-31", [
      "UPDATE transcript_batches SET model = 'e1' WHERE model <> 'e1'",
      `UPDATE user_settings SET value = (value - 'asrE2' - 'asrE3') || '{"asrE1":"qwen-audio-3.1-asr-flash-filetrans","transcriptPostprocess":"deepseek-v4.1-flash","summary":"deepseek-v4.1-flash"}'::jsonb WHERE category = 'aiModels'`,
    ]],
  ] as const;
  for (const [version, statements] of migrations) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [version]);
      const applied = await client.query("SELECT version FROM app_schema_migrations WHERE version = $1", [version]);
      if (!applied.rows.length) {
        for (const statement of statements) await client.query(statement);
        await client.query("INSERT INTO app_schema_migrations (version) VALUES ($1)", [version]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

// The old v3 marker predates the current non-destructive legacy reconciliation.
// Give this schema snapshot its own version so older installations upgrade once.
const TRANSCRIPT_HISTORY_SCHEMA_VERSION = "transcript-schema-v5-incremental-history";

async function migrateTranscriptHistorySchema(db: PooledQueryable): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [TRANSCRIPT_HISTORY_SCHEMA_VERSION]);
    const applied = await client.query<{ version: string }>(
      "SELECT version FROM app_schema_migrations WHERE version = $1",
      [TRANSCRIPT_HISTORY_SCHEMA_VERSION],
    );
    if (applied.rows.length > 0) {
      await client.query("COMMIT");
      return;
    }
    for (const statement of TRANSCRIPT_SCHEMA_BASE_STATEMENTS) {
      await client.query(statement);
    }
    await migrateLegacyTranscriptHistory(client);
    for (const statement of TRANSCRIPT_SCHEMA_FINALIZE_STATEMENTS) {
      await client.query(statement);
    }
    await client.query(
      "INSERT INTO app_schema_migrations (version) VALUES ($1)",
      [TRANSCRIPT_HISTORY_SCHEMA_VERSION],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const LEGACY_HISTORY_COLUMNS = new Set(["display_title", "original_title"]);

async function migrateLegacyTranscriptHistory(db: Queryable): Promise<void> {
  const columns = await db.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'transcript_history_records'`,
  );
  const existing = new Set(columns.rows.map(({ column_name }) => column_name));
  for (const statement of LEGACY_HISTORY_COLUMN_STATEMENTS) {
    await db.query(statement);
  }

  const captionSources = [
    "caption",
    ...(existing.has("original_title") ? ["original_title"] : []),
    ...(existing.has("display_title") ? ["display_title"] : []),
    "'历史记录'",
  ];
  const sessionNameSources = [
    "session_name",
    ...(existing.has("display_title") ? ["display_title"] : []),
    ...captionSources,
  ];
  const now = Date.now();
  await db.query(
    `UPDATE transcript_history_records
     SET work_key = COALESCE(work_key, 'legacy:' || id),
         work_id = COALESCE(work_id, id),
         work_kind = COALESCE(work_kind, 'video'),
         input_url = COALESCE(input_url, ''),
         final_url = COALESCE(final_url, ''),
         caption = COALESCE(${captionSources.join(", ")}),
         session_name = COALESCE(${sessionNameSources.join(", ")}),
         transcript_content = COALESCE(transcript_content, ''),
         created_at = COALESCE(created_at, $1),
         updated_at = COALESCE(updated_at, $1)`,
    [now],
  );

  for (const column of existing) {
    if (LEGACY_HISTORY_COLUMNS.has(column)) {
      await db.query(`ALTER TABLE transcript_history_records DROP COLUMN ${column}`);
    }
  }
}

const LEGACY_HISTORY_COLUMN_STATEMENTS = [
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS work_key text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS work_id text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS work_kind text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS input_url text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS final_url text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS author_name text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS author_url text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS caption text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS session_name text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS duration_seconds double precision",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS transcript_content text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS transcript_segments jsonb",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS created_at bigint",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS updated_at bigint",
];

const TRANSCRIPT_SCHEMA_V4_VERSION = "transcript-schema-v4-single-history-record";

async function migrateTranscriptSchemaV4(db: PooledQueryable): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [TRANSCRIPT_SCHEMA_V4_VERSION]);
    const applied = await client.query<{ version: string }>(
      "SELECT version FROM app_schema_migrations WHERE version = $1",
      [TRANSCRIPT_SCHEMA_V4_VERSION],
    );
    if (applied.rows.length > 0) {
      await client.query("COMMIT");
      return;
    }
    await client.query("DROP TABLE IF EXISTS transcript_history_assets");
    for (const statement of TRANSCRIPT_SCHEMA_V4_STATEMENTS) {
      await client.query(statement);
    }
    await migrateLegacyOriginalAudioColumn(client);
    await client.query("INSERT INTO app_schema_migrations (version) VALUES ($1)", [TRANSCRIPT_SCHEMA_V4_VERSION]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const TRANSCRIPT_SCHEMA_V4_STATEMENTS = [
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS avatar_url text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS cover_url text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS video_url text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS dubbing_url text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS original_audio text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS source_metadata_refreshed_at bigint",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS source_urls_expires_at bigint",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS media_quality text",
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS dash_video_url text",
];

async function migrateLegacyOriginalAudioColumn(db: Queryable): Promise<void> {
  const result = await db.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'transcript_history_records'
       AND column_name = 'original_audio_object_key'`,
  );
  if (result.rows.length === 0) return;
  await db.query(
    `UPDATE transcript_history_records
     SET original_audio = COALESCE(original_audio, original_audio_object_key)`,
  );
  await db.query("ALTER TABLE transcript_history_records DROP COLUMN original_audio_object_key");
}

const LEGACY_AUTH_DISPLAY_VIEWS = new Set(["users_display", "sessions_display", "email_codes_display"]);

async function dropLegacyAuthDisplayViews(db: Queryable): Promise<void> {
  const result = await db.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'VIEW'
       AND table_name IN ('users_display', 'sessions_display', 'email_codes_display')`,
  );
  for (const { table_name: view } of result.rows) {
    if (LEGACY_AUTH_DISPLAY_VIEWS.has(view)) {
      await db.query(`DROP VIEW ${view}`);
    }
  }
}

const AUTH_TIMESTAMP_COLUMNS = new Set([
  "email_codes.expires_at",
  "email_codes.sent_at",
  "email_codes.used_at",
  "sessions.expires_at",
  "sessions.created_at",
  "sessions.last_seen_at",
  "users.terms_accepted_at",
  "users.created_at",
  "users.updated_at",
]);

async function migrateLegacyAuthTimestamps(db: Queryable): Promise<void> {
  const result = await db.query<{ column_name: string; table_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type = 'bigint'
       AND table_name IN ('users', 'sessions', 'email_codes')`,
  );
  for (const { column_name: column, table_name: table } of result.rows) {
    if (AUTH_TIMESTAMP_COLUMNS.has(`${table}.${column}`)) {
      await db.query(
        `ALTER TABLE ${table}
         ALTER COLUMN ${column} TYPE timestamptz(3)
         USING to_timestamp(${column}::double precision / 1000)`,
      );
    }
  }
}

const CORE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS app_schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz(3) NOT NULL DEFAULT now()
    )`,
  `CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      username text NOT NULL,
      email text NOT NULL,
      password_hash text NOT NULL,
      terms_accepted_at timestamptz(3) NOT NULL,
      created_at timestamptz(3) NOT NULL,
      updated_at timestamptz(3) NOT NULL
    )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uidx ON users (lower(username))",
  "CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx ON users (lower(email))",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user'))",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS douyin_account_services_enabled boolean NOT NULL DEFAULT false",
  "UPDATE users SET role = 'admin' WHERE lower(username) = 'timesea' AND role <> 'admin'",
  `CREATE TABLE IF NOT EXISTS account_service_invitations (
      id text PRIMARY KEY,
      code text NOT NULL UNIQUE,
      environment text NOT NULL DEFAULT 'development' CHECK (environment IN ('development', 'production')),
      created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      redeemed_by text UNIQUE REFERENCES users(id) ON DELETE SET NULL,
      redeemed_at timestamptz(3),
      CHECK (redeemed_by IS NULL OR redeemed_at IS NOT NULL)
    )`,
  "ALTER TABLE account_service_invitations ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'development'",
  "ALTER TABLE account_service_invitations DROP CONSTRAINT IF EXISTS account_service_invitations_environment_check",
  "ALTER TABLE account_service_invitations ADD CONSTRAINT account_service_invitations_environment_check CHECK (environment IN ('development', 'production'))",
  "CREATE INDEX IF NOT EXISTS account_service_invitations_environment_status_idx ON account_service_invitations(environment, redeemed_at, created_at)",
  `CREATE TABLE IF NOT EXISTS user_feedback (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
      type text CHECK (type IN ('bug', 'feature', 'other')),
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at timestamptz(3)
    )`,
  "CREATE INDEX IF NOT EXISTS user_feedback_status_created_idx ON user_feedback(status, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS user_feedback_user_created_idx ON user_feedback(user_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz(3) NOT NULL,
      created_at timestamptz(3) NOT NULL,
      last_seen_at timestamptz(3) NOT NULL
    )`,
  "CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)",
  "CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)",
  `CREATE TABLE IF NOT EXISTS email_codes (
      id text PRIMARY KEY,
      email text NOT NULL,
      purpose text NOT NULL,
      code_hash text NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      expires_at timestamptz(3) NOT NULL,
      sent_at timestamptz(3) NOT NULL,
      used_at timestamptz(3)
    )`,
  `CREATE INDEX IF NOT EXISTS email_codes_lookup_idx
      ON email_codes(lower(email), purpose, used_at, sent_at DESC)`,
  `CREATE TABLE IF NOT EXISTS auth_rate_limits (
      scope text NOT NULL,
      subject_hash text NOT NULL,
      attempts integer NOT NULL,
      window_started_at timestamptz(3) NOT NULL,
      updated_at timestamptz(3) NOT NULL,
      PRIMARY KEY(scope, subject_hash)
    )`,
  "CREATE INDEX IF NOT EXISTS auth_rate_limits_updated_at_idx ON auth_rate_limits(updated_at)",
  `CREATE TABLE IF NOT EXISTS user_settings (
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category text NOT NULL,
      value jsonb NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY (user_id, category)
    )`,
  `CREATE TABLE IF NOT EXISTS api_access_tokens (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      token_encrypted jsonb,
      token_prefix text NOT NULL,
      expires_at timestamptz(3),
      last_used_at timestamptz(3),
      revoked_at timestamptz(3),
      created_at timestamptz(3) NOT NULL,
      updated_at timestamptz(3) NOT NULL
    )`,
  "ALTER TABLE api_access_tokens ADD COLUMN IF NOT EXISTS token_encrypted jsonb",
  "CREATE INDEX IF NOT EXISTS api_access_tokens_user_status_idx ON api_access_tokens(user_id, revoked_at, expires_at)",
  "CREATE INDEX IF NOT EXISTS api_access_tokens_prefix_idx ON api_access_tokens(token_prefix)",
];

const TRANSCRIPT_SCHEMA_BASE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS transcript_open_api_quota_usage (
      user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      used_seconds double precision NOT NULL DEFAULT 0 CHECK (used_seconds >= 0),
      updated_at bigint NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS transcript_asr_tasks (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_key text NOT NULL,
      cache_key text NOT NULL,
      task_id text NOT NULL,
      object_key text NOT NULL,
      model text NOT NULL,
      credential_source text NOT NULL DEFAULT 'platform'
        CHECK (credential_source IN ('platform', 'custom')),
      audio_duration_seconds double precision NOT NULL DEFAULT 0,
      history_record_id text,
      history_work jsonb,
      status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'canceled')),
      error_detail text,
      updated_at bigint NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS transcript_asr_tasks_user_cache_idx
      ON transcript_asr_tasks(user_id, cache_key, status, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS transcript_history_records (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_key text NOT NULL,
      work_id text NOT NULL,
      work_kind text NOT NULL,
      input_url text NOT NULL,
      final_url text NOT NULL,
      author_name text,
      author_url text,
      caption text NOT NULL,
      session_name text NOT NULL,
      duration_seconds double precision,
      transcript_content text NOT NULL,
      transcript_segments jsonb,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    )`,
];

const TRANSCRIPT_SCHEMA_FINALIZE_STATEMENTS = [
  "CREATE UNIQUE INDEX IF NOT EXISTS transcript_history_records_id_uidx ON transcript_history_records(id)",
  `CREATE UNIQUE INDEX IF NOT EXISTS transcript_history_records_user_work_uidx
      ON transcript_history_records(user_id, work_key)`,
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS pinned_at bigint",
  `CREATE INDEX IF NOT EXISTS transcript_history_records_user_updated_idx
      ON transcript_history_records(user_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS transcript_history_comments (
      history_record_id text PRIMARY KEY REFERENCES transcript_history_records(id) ON DELETE CASCADE,
      payload jsonb NOT NULL,
      comment_count integer NOT NULL,
      collected_at bigint NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS transcript_history_summaries (
      id text PRIMARY KEY,
      history_record_id text NOT NULL REFERENCES transcript_history_records(id) ON DELETE CASCADE,
      prompt_id text NOT NULL,
      prompt_title text NOT NULL,
      content text NOT NULL,
      created_at bigint NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS transcript_history_summaries_record_idx
      ON transcript_history_summaries(history_record_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS transcript_custom_prompts (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title text NOT NULL,
      description text NOT NULL,
      prompt text NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS transcript_custom_prompts_user_created_idx
      ON transcript_custom_prompts(user_id, created_at ASC)`,
];

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
