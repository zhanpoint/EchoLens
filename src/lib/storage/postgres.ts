import { Pool, types, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

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
};

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

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }

  const config: PoolConfig = {
    connectionString,
    max: readPositiveIntegerEnv("POSTGRES_POOL_MAX", 10),
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
  if (!globalForPostgres.__echolensPostgresSchemaReady) {
    globalForPostgres.__echolensPostgresSchemaReady = migrateSchema(getPostgresPool()).catch((error) => {
      delete globalForPostgres.__echolensPostgresSchemaReady;
      throw error;
    });
  }
  await globalForPostgres.__echolensPostgresSchemaReady;
}

export async function closePostgresPool(): Promise<void> {
  await globalForPostgres.__echolensPostgresPool?.end();
  delete globalForPostgres.__echolensPostgresPool;
  delete globalForPostgres.__echolensPostgresSchemaReady;
}

export const closePostgresPoolForTest = closePostgresPool;

export function setPostgresPoolForTest(pool: PooledQueryable): void {
  globalForPostgres.__echolensPostgresPool = pool;
  delete globalForPostgres.__echolensPostgresSchemaReady;
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
  await migrateTranscriptSchemaV3(db);
}

const TRANSCRIPT_SCHEMA_V3_VERSION = "transcript-schema-v3-session-name";

async function migrateTranscriptSchemaV3(db: PooledQueryable): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [TRANSCRIPT_SCHEMA_V3_VERSION]);
    const applied = await client.query<{ version: string }>(
      "SELECT version FROM app_schema_migrations WHERE version = $1",
      [TRANSCRIPT_SCHEMA_V3_VERSION],
    );
    if (applied.rows.length === 0) {
      for (const statement of RESET_TRANSCRIPT_SCHEMA_STATEMENTS) {
        await client.query(statement);
      }
    }
    for (const statement of TRANSCRIPT_SCHEMA_STATEMENTS) {
      await client.query(statement);
    }
    if (applied.rows.length === 0) {
      await client.query(
        "INSERT INTO app_schema_migrations (version) VALUES ($1)",
        [TRANSCRIPT_SCHEMA_V3_VERSION],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const RESET_TRANSCRIPT_SCHEMA_STATEMENTS = [
  "DROP TABLE IF EXISTS transcript_history_summaries",
  "DROP TABLE IF EXISTS transcript_history_assets",
  "DROP TABLE IF EXISTS transcript_asr_tasks",
  "DROP TABLE IF EXISTS transcript_custom_prompts",
  "DROP TABLE IF EXISTS transcript_history_records",
  "DROP TABLE IF EXISTS douyin_favorites_cache",
  "DROP TABLE IF EXISTS douyin_following_cache",
  "DROP INDEX IF EXISTS user_settings_user_id_idx",
];

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
];

const TRANSCRIPT_SCHEMA_STATEMENTS = [
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
  `CREATE UNIQUE INDEX IF NOT EXISTS transcript_history_records_user_work_uidx
      ON transcript_history_records(user_id, work_key)`,
  "ALTER TABLE transcript_history_records ADD COLUMN IF NOT EXISTS pinned_at bigint",
  `CREATE INDEX IF NOT EXISTS transcript_history_records_user_updated_idx
      ON transcript_history_records(user_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS transcript_history_assets (
      history_record_id text NOT NULL REFERENCES transcript_history_records(id) ON DELETE CASCADE,
      asset_kind text NOT NULL CHECK (asset_kind IN ('avatar', 'cover', 'video', 'originalAudio')),
      object_key text NOT NULL,
      content_type text NOT NULL,
      size_bytes bigint NOT NULL,
      duration_seconds double precision,
      verified_at bigint,
      updated_at bigint NOT NULL,
      PRIMARY KEY(history_record_id, asset_kind)
    )`,
  "ALTER TABLE transcript_history_assets ADD COLUMN IF NOT EXISTS verified_at bigint",
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
