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

async function migrateSchema(db: Queryable): Promise<void> {
  await dropLegacyAuthDisplayViews(db);
  for (const statement of SCHEMA_STATEMENTS) {
    await db.query(statement);
  }
  await migrateLegacyAuthTimestamps(db);
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

const SCHEMA_STATEMENTS = [
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
  `CREATE TABLE IF NOT EXISTS user_settings (
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category text NOT NULL,
      value jsonb NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY (user_id, category)
    )`,
  "CREATE INDEX IF NOT EXISTS user_settings_user_id_idx ON user_settings(user_id)",
  "DROP TABLE IF EXISTS douyin_favorites_cache",
  "DROP TABLE IF EXISTS douyin_following_cache",
  `CREATE TABLE IF NOT EXISTS transcript_asr_audio_cache (
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_key text NOT NULL,
      object_key text NOT NULL,
      duration_seconds double precision NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY(user_id, work_key, object_key)
    )`,
  `CREATE INDEX IF NOT EXISTS transcript_asr_audio_cache_user_work_idx
      ON transcript_asr_audio_cache(user_id, work_key, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS transcript_asr_tasks (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_key text NOT NULL,
      cache_key text NOT NULL,
      task_id text NOT NULL,
      object_key text NOT NULL,
      model text NOT NULL,
      audio_duration_seconds double precision NOT NULL DEFAULT 0,
      history_record_id text,
      history_work jsonb,
      status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'canceled')),
      error_detail text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      completed_at bigint
    )`,
  `CREATE INDEX IF NOT EXISTS transcript_asr_tasks_user_idx
      ON transcript_asr_tasks(user_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS transcript_asr_tasks_user_cache_idx
      ON transcript_asr_tasks(user_id, cache_key, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS transcript_asr_tasks_user_completed_idx
      ON transcript_asr_tasks(user_id, status, completed_at)`,
  `CREATE TABLE IF NOT EXISTS transcript_history_records (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_key text NOT NULL,
      work_id text NOT NULL,
      work_kind text NOT NULL,
      input_url text NOT NULL,
      final_url text NOT NULL,
      author_name text,
      original_title text NOT NULL,
      display_title text NOT NULL,
      duration_seconds double precision,
      transcript_content text NOT NULL,
      transcript_segments jsonb,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS transcript_history_records_user_updated_idx
      ON transcript_history_records(user_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS transcript_history_records_user_work_idx
      ON transcript_history_records(user_id, work_key, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS transcript_history_summaries (
      id text PRIMARY KEY,
      history_record_id text NOT NULL REFERENCES transcript_history_records(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompt_id text NOT NULL,
      prompt_title text NOT NULL,
      content text NOT NULL,
      created_at bigint NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS transcript_history_summaries_record_idx
      ON transcript_history_summaries(user_id, history_record_id, created_at DESC)`,
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
