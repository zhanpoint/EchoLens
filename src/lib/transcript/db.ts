import Database from "better-sqlite3";
import { getSqliteDb } from "@/lib/storage/sqlite";
import type { ProviderResult } from "@/lib/ai/provider-result";
import type { TranscriptSegment } from "@/types/douyin";

type StoredTranscriptRow = {
  content: string;
  model: string | null;
  postprocess_version: string | null;
  segments_json: string | null;
};
type StoredAsrTaskRow = {
  audio_duration_seconds: number | null;
  cache_key: string;
  error_detail: string | null;
  id: string;
  model: string | null;
  object_key: string;
  status: StoredAsrTaskStatus;
  task_id: string;
  updated_at: number;
  user_id: string;
  work_key: string;
};
type StoredAsrAudioCacheRow = {
  duration_seconds: number;
  object_key: string;
  updated_at: number;
};

type GlobalWithTranscriptDb = typeof globalThis & {
  __echolensTranscriptDbMigrated?: number;
};

const TRANSCRIPT_SCHEMA_VERSION = 5;
const globalForTranscriptDb = globalThis as GlobalWithTranscriptDb;

export type StoredAsrTaskStatus = "running" | "succeeded" | "failed";
export type StoredAsrTask = {
  audioDurationSeconds: number;
  cacheKey: string;
  errorDetail?: string;
  id: string;
  model: string;
  objectKey: string;
  status: StoredAsrTaskStatus;
  taskId: string;
  updatedAt: number;
  userId: string;
  workKey: string;
};
export type StoredAsrAudioCache = {
  durationSeconds: number;
  objectKey: string;
  updatedAt: number;
};

export function getTranscriptDb(): Database.Database {
  const db = getSqliteDb();
  if (globalForTranscriptDb.__echolensTranscriptDbMigrated !== TRANSCRIPT_SCHEMA_VERSION) {
    migrate(db);
    globalForTranscriptDb.__echolensTranscriptDbMigrated = TRANSCRIPT_SCHEMA_VERSION;
  }
  return db;
}

export function readStoredTranscript(input: {
  cacheKey: string;
  userId: string;
}): Extract<ProviderResult, { ok: true }> | null {
  const row = getTranscriptDb()
    .prepare(
      `SELECT content, model, postprocess_version, segments_json
       FROM transcript_results
       WHERE user_id = ? AND cache_key = ?
       LIMIT 1`,
    )
    .get(input.userId, input.cacheKey) as StoredTranscriptRow | undefined;

  if (!row) {
    return null;
  }

  return {
    ok: true,
    asrModel: row.model ?? undefined,
    content: row.content,
    emotions: parseEmotions(row.segments_json),
    postprocessVersion: row.postprocess_version ?? undefined,
    transcriptSegments: parseSegments(row.segments_json),
  };
}

export function upsertStoredTranscript(input: {
  cacheKey: string;
  content: string;
  model: string;
  postprocessVersion?: string;
  source: string;
  transcriptSegments?: TranscriptSegment[];
  userId: string;
  workKey: string;
}): void {
  const now = Date.now();
  getTranscriptDb()
    .prepare(
      `INSERT INTO transcript_results (
         id, user_id, work_key, cache_key, source, model,
         content, segments_json, postprocess_version, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, cache_key) DO UPDATE SET
         content = excluded.content,
         segments_json = excluded.segments_json,
         postprocess_version = excluded.postprocess_version,
         source = excluded.source,
         model = excluded.model,
         updated_at = excluded.updated_at`,
    )
    .run(
      `${input.userId}:${input.cacheKey}`,
      input.userId,
      input.workKey,
      input.cacheKey,
      input.source,
      input.model,
      input.content,
      JSON.stringify(input.transcriptSegments ?? []),
      input.postprocessVersion ?? null,
      now,
      now,
    );
}

export function upsertAsrAudioCache(input: {
  durationSeconds: number;
  objectKey: string;
  userId: string;
  workKey: string;
}): void {
  const now = Date.now();
  getTranscriptDb()
    .prepare(
      `INSERT INTO transcript_asr_audio_cache (
         user_id, work_key, object_key, duration_seconds, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, work_key, object_key) DO UPDATE SET
         duration_seconds = excluded.duration_seconds,
         updated_at = excluded.updated_at`,
    )
    .run(input.userId, input.workKey, input.objectKey, input.durationSeconds, now, now);
}

export function readAsrAudioCache(input: {
  objectKey: string;
  userId: string;
}): StoredAsrAudioCache | null {
  const row = getTranscriptDb()
    .prepare(
      `SELECT object_key, duration_seconds, updated_at
       FROM transcript_asr_audio_cache
       WHERE user_id = ? AND object_key = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(input.userId, input.objectKey) as StoredAsrAudioCacheRow | undefined;

  return row
    ? {
        durationSeconds: row.duration_seconds,
        objectKey: row.object_key,
        updatedAt: row.updated_at,
      }
    : null;
}

export function insertAsrTask(input: {
  audioDurationSeconds: number;
  cacheKey: string;
  id: string;
  model: string;
  objectKey: string;
  taskId: string;
  userId: string;
  workKey: string;
}): void {
  const now = Date.now();
  getTranscriptDb()
    .prepare(
      `INSERT INTO transcript_asr_tasks (
       id, user_id, work_key, cache_key, task_id, object_key, model,
         audio_duration_seconds, status, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    )
    .run(
      input.id,
      input.userId,
      input.workKey,
      input.cacheKey,
      input.taskId,
      input.objectKey,
      input.model,
      input.audioDurationSeconds,
      now,
      now,
    );
}

export function readRunningAsrTask(input: {
  cacheKey: string;
  userId: string;
}): StoredAsrTask | null {
  const row = getTranscriptDb()
    .prepare(
      `SELECT id, user_id, work_key, cache_key, task_id, object_key, model, audio_duration_seconds, status, error_detail, updated_at
       FROM transcript_asr_tasks
       WHERE user_id = ? AND cache_key = ? AND status = 'running'
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(input.userId, input.cacheKey) as StoredAsrTaskRow | undefined;

  return row ? mapAsrTask(row) : null;
}

export function readAsrTask(input: {
  id: string;
  userId: string;
}): StoredAsrTask | null {
  const row = getTranscriptDb()
    .prepare(
      `SELECT id, user_id, work_key, cache_key, task_id, object_key, model, audio_duration_seconds, status, error_detail, updated_at
       FROM transcript_asr_tasks
       WHERE user_id = ? AND id = ?
       LIMIT 1`,
    )
    .get(input.userId, input.id) as StoredAsrTaskRow | undefined;

  return row ? mapAsrTask(row) : null;
}

export function readAsrTaskByTaskId(taskId: string): StoredAsrTask | null {
  const row = getTranscriptDb()
    .prepare(
      `SELECT id, user_id, work_key, cache_key, task_id, object_key, model, audio_duration_seconds, status, error_detail, updated_at
       FROM transcript_asr_tasks
       WHERE task_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(taskId) as StoredAsrTaskRow | undefined;

  return row ? mapAsrTask(row) : null;
}

export function markAsrTaskRunning(id: string): void {
  getTranscriptDb()
    .prepare(
      `UPDATE transcript_asr_tasks
       SET updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(Date.now(), id);
}

export function markAsrTaskSucceeded(id: string): void {
  const now = Date.now();
  getTranscriptDb()
    .prepare(
      `UPDATE transcript_asr_tasks
       SET status = 'succeeded', updated_at = ?, completed_at = ?
       WHERE id = ?`,
    )
    .run(now, now, id);
}

export function markAsrTaskFailed(id: string, detail: string): void {
  const now = Date.now();
  getTranscriptDb()
    .prepare(
      `UPDATE transcript_asr_tasks
       SET status = 'failed', error_detail = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
    )
    .run(detail, now, now, id);
}

export function readDailySucceededAsrDurationSeconds(input: {
  now?: number;
  userId: string;
}): number {
  const now = input.now ?? Date.now();
  const start = startOfLocalDay(now);
  const end = startOfNextLocalDay(now);
  const row = getTranscriptDb()
    .prepare(
      `SELECT COALESCE(SUM(audio_duration_seconds), 0) AS total
       FROM transcript_asr_tasks
       WHERE user_id = ?
         AND status = 'succeeded'
         AND completed_at >= ?
         AND completed_at < ?`,
    )
    .get(input.userId, start, end) as { total: number } | undefined;

  return Number(row?.total ?? 0);
}

export function nextAsrQuotaResetAt(now = Date.now()): number {
  return startOfNextLocalDay(now);
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_results (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      work_key TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT NOT NULL,
      content TEXT NOT NULL,
      segments_json TEXT,
      postprocess_version TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, cache_key)
    );

    CREATE INDEX IF NOT EXISTS transcript_results_user_work_idx
      ON transcript_results(user_id, work_key, updated_at);

    CREATE VIEW IF NOT EXISTS transcript_results_display AS
    SELECT
      id,
      user_id,
      work_key,
      source,
      model,
      content,
      strftime('%Y年%m月%d日 %H:%M:%S', created_at / 1000, 'unixepoch', '+8 hours') AS created_at,
      strftime('%Y年%m月%d日 %H:%M:%S', updated_at / 1000, 'unixepoch', '+8 hours') AS updated_at
    FROM transcript_results;

    CREATE TABLE IF NOT EXISTS transcript_asr_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      work_key TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      model TEXT,
      audio_duration_seconds REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error_detail TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS transcript_asr_tasks_user_idx
      ON transcript_asr_tasks(user_id, updated_at);

    CREATE INDEX IF NOT EXISTS transcript_asr_tasks_user_cache_idx
      ON transcript_asr_tasks(user_id, cache_key, status, updated_at);

    CREATE TABLE IF NOT EXISTS transcript_asr_audio_cache (
      user_id TEXT NOT NULL,
      work_key TEXT NOT NULL,
      object_key TEXT NOT NULL,
      duration_seconds REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, work_key, object_key)
    );

    CREATE INDEX IF NOT EXISTS transcript_asr_audio_cache_user_work_idx
      ON transcript_asr_audio_cache(user_id, work_key, updated_at);
  `);
  ensureColumn(db, "transcript_asr_tasks", "model", "TEXT");
  ensureColumn(db, "transcript_asr_tasks", "audio_duration_seconds", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "transcript_results", "postprocess_version", "TEXT");
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function mapAsrTask(row: StoredAsrTaskRow): StoredAsrTask {
  return {
    audioDurationSeconds: row.audio_duration_seconds ?? 0,
    cacheKey: row.cache_key,
    errorDetail: row.error_detail ?? undefined,
    id: row.id,
    model: row.model ?? "",
    objectKey: row.object_key,
    status: row.status,
    taskId: row.task_id,
    updatedAt: row.updated_at,
    userId: row.user_id,
    workKey: row.work_key,
  };
}

function startOfLocalDay(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfNextLocalDay(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function parseSegments(value: string | null): TranscriptSegment[] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const segments = parsed
      .map((item): TranscriptSegment | null => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const segment = item as Partial<TranscriptSegment>;
        return typeof segment.text === "string" &&
          typeof segment.startSeconds === "number" &&
          typeof segment.endSeconds === "number"
          ? {
              endSeconds: segment.endSeconds,
              emotion: typeof segment.emotion === "string" ? segment.emotion : undefined,
              speakerId: typeof segment.speakerId === "string" ? segment.speakerId : undefined,
              startSeconds: segment.startSeconds,
              text: segment.text,
            }
          : null;
      })
      .filter((segment): segment is TranscriptSegment => Boolean(segment));

    return segments.length > 0 ? segments : undefined;
  } catch {
    return undefined;
  }
}

function parseEmotions(value: string | null): string[] | undefined {
  const emotions = parseSegments(value)
    ?.map((segment) => segment.emotion)
    .filter((emotion): emotion is string => Boolean(emotion));
  return emotions?.length ? [...new Set(emotions)] : undefined;
}
