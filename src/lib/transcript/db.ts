import Database from "better-sqlite3";
import { getSqliteDb } from "@/lib/storage/sqlite";

type StoredAsrTaskRow = {
  audio_duration_seconds: number | null;
  cache_key: string;
  error_detail: string | null;
  history_record_id: string | null;
  history_work_json: string | null;
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
type TranscriptHistoryRecordRow = {
  author_name: string | null;
  created_at: number;
  display_title: string;
  duration_seconds: number | null;
  final_url: string;
  id: string;
  input_url: string;
  original_title: string;
  transcript_content: string;
  transcript_segments_json: string | null;
  updated_at: number;
  user_id: string;
  work_id: string;
  work_key: string;
  work_kind: string;
};
type TranscriptHistorySummaryRow = {
  content: string;
  created_at: number;
  id: string;
  prompt_id: string;
  prompt_title: string;
};

type GlobalWithTranscriptDb = typeof globalThis & {
  __echolensTranscriptDbMigrated?: number;
};

const TRANSCRIPT_SCHEMA_VERSION = 9;
const globalForTranscriptDb = globalThis as GlobalWithTranscriptDb;

export type StoredAsrTaskStatus = "running" | "succeeded" | "failed" | "canceled";
export type StoredAsrTask = {
  audioDurationSeconds: number;
  cacheKey: string;
  errorDetail?: string;
  historyContext?: StoredAsrHistoryContext;
  id: string;
  model: string;
  objectKey: string;
  status: StoredAsrTaskStatus;
  taskId: string;
  updatedAt: number;
  userId: string;
  workKey: string;
};
export type StoredAsrHistoryContext = {
  historyRecordId: string;
  work: unknown;
};
export type StoredAsrAudioCache = {
  durationSeconds: number;
  objectKey: string;
  updatedAt: number;
};
export type TranscriptHistoryRecord = {
  authorName?: string;
  createdAt: number;
  displayTitle: string;
  durationSeconds?: number;
  finalUrl: string;
  id: string;
  inputUrl: string;
  originalTitle: string;
  transcriptContent: string;
  transcriptSegments?: unknown;
  updatedAt: number;
  userId: string;
  workId: string;
  workKey: string;
  workKind: string;
};
export type TranscriptHistorySummary = {
  content: string;
  createdAt: number;
  id: string;
  promptId: string;
  promptTitle: string;
};

export function getTranscriptDb(): Database.Database {
  const db = getSqliteDb();
  if (globalForTranscriptDb.__echolensTranscriptDbMigrated !== TRANSCRIPT_SCHEMA_VERSION) {
    migrate(db);
    globalForTranscriptDb.__echolensTranscriptDbMigrated = TRANSCRIPT_SCHEMA_VERSION;
  }
  return db;
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
  historyContext?: StoredAsrHistoryContext;
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
         audio_duration_seconds, history_record_id, history_work_json, status, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
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
      input.historyContext?.historyRecordId ?? null,
      input.historyContext?.work === undefined ? null : JSON.stringify(input.historyContext.work),
      now,
      now,
    );
}

export function reserveAsrTask(input: {
  audioDurationSeconds: number;
  cacheKey: string;
  historyContext?: StoredAsrHistoryContext;
  id: string;
  model: string;
  objectKey: string;
  userId: string;
  workKey: string;
}): void {
  insertAsrTask({
    ...input,
    taskId: `pending:${input.id}`,
  });
}

export function markAsrJobCancellationRequested(input: {
  id: string;
  userId: string;
}): void {
  const now = Date.now();
  getTranscriptDb()
    .prepare(
      `INSERT INTO transcript_asr_job_cancellations (id, user_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id, user_id) DO UPDATE SET created_at = excluded.created_at`,
    )
    .run(input.id, input.userId, now);
}

export function isAsrJobCancellationRequested(input: {
  id: string;
  userId: string;
}): boolean {
  const row = getTranscriptDb()
    .prepare(
      `SELECT 1 AS found
       FROM transcript_asr_job_cancellations
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
    )
    .get(input.id, input.userId) as { found: number } | undefined;
  return Boolean(row);
}

export function attachAsrTaskProviderTask(input: {
  id: string;
  taskId: string;
}): boolean {
  const result = getTranscriptDb()
    .prepare(
      `UPDATE transcript_asr_tasks
       SET task_id = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(input.taskId, Date.now(), input.id);
  return result.changes > 0;
}

export function readRunningAsrTask(input: {
  cacheKey: string;
  userId: string;
}): StoredAsrTask | null {
  const row = getTranscriptDb()
    .prepare(
      `SELECT ${ASR_TASK_COLUMNS}
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
      `SELECT ${ASR_TASK_COLUMNS}
       FROM transcript_asr_tasks
       WHERE user_id = ? AND id = ?
       LIMIT 1`,
    )
    .get(input.userId, input.id) as StoredAsrTaskRow | undefined;

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

export function markAsrTaskCanceled(id: string, detail = "用户已放弃当前转录任务。"): void {
  const now = Date.now();
  getTranscriptDb()
    .prepare(
      `UPDATE transcript_asr_tasks
       SET status = 'canceled', error_detail = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
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

export function upsertTranscriptHistoryRecord(input: {
  authorName?: string;
  displayTitle?: string;
  durationSeconds?: number;
  finalUrl: string;
  id: string;
  inputUrl: string;
  originalTitle?: string;
  transcriptContent: string;
  transcriptSegments?: unknown;
  userId: string;
  workId: string;
  workKey: string;
  workKind: string;
}): TranscriptHistoryRecord {
  const now = Date.now();
  const title = normalizeHistoryTitle(input.originalTitle, input.finalUrl);
  getTranscriptDb()
    .prepare(
      `INSERT INTO transcript_history_records (
         id, user_id, work_key, work_id, work_kind, input_url, final_url,
         author_name, original_title, display_title, duration_seconds,
         transcript_content, transcript_segments_json, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         input_url = excluded.input_url,
         final_url = excluded.final_url,
         author_name = excluded.author_name,
         original_title = excluded.original_title,
         duration_seconds = excluded.duration_seconds,
         transcript_content = excluded.transcript_content,
         transcript_segments_json = excluded.transcript_segments_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.id,
      input.userId,
      input.workKey,
      input.workId,
      input.workKind,
      input.inputUrl,
      input.finalUrl,
      input.authorName ?? null,
      title,
      input.displayTitle?.trim() || title,
      input.durationSeconds ?? null,
      input.transcriptContent,
      input.transcriptSegments === undefined ? null : JSON.stringify(input.transcriptSegments),
      now,
      now,
    );

  const record = readTranscriptHistoryRecord({ id: input.id, userId: input.userId });
  if (!record) {
    throw new Error("转录历史保存失败。");
  }
  return record;
}

export function listTranscriptHistoryRecords(input: {
  limit?: number;
  query?: string;
  userId: string;
}): TranscriptHistoryRecord[] {
  const limit = Math.min(Math.max(input.limit ?? 80, 1), 200);
  const query = input.query?.trim();
  const sql = query
    ? `SELECT ${HISTORY_RECORD_COLUMNS}
       FROM transcript_history_records
       WHERE user_id = ? AND display_title LIKE ?
       ORDER BY updated_at DESC
       LIMIT ?`
    : `SELECT ${HISTORY_RECORD_COLUMNS}
       FROM transcript_history_records
       WHERE user_id = ?
       ORDER BY updated_at DESC
       LIMIT ?`;
  const params = query ? [input.userId, `%${query}%`, limit] : [input.userId, limit];
  const rows = getTranscriptDb().prepare(sql).all(...params) as TranscriptHistoryRecordRow[];
  return rows.map(mapTranscriptHistoryRecord);
}

export function readTranscriptHistoryRecord(input: {
  id: string;
  userId: string;
}): TranscriptHistoryRecord | null {
  const row = getTranscriptDb()
    .prepare(
      `SELECT ${HISTORY_RECORD_COLUMNS}
       FROM transcript_history_records
       WHERE user_id = ? AND id = ?
       LIMIT 1`,
    )
    .get(input.userId, input.id) as TranscriptHistoryRecordRow | undefined;

  return row ? mapTranscriptHistoryRecord(row) : null;
}

export function renameTranscriptHistoryRecord(input: {
  displayTitle: string;
  id: string;
  userId: string;
}): TranscriptHistoryRecord | null {
  getTranscriptDb()
    .prepare(
      `UPDATE transcript_history_records
       SET display_title = ?, updated_at = ?
       WHERE user_id = ? AND id = ?`,
    )
    .run(input.displayTitle.trim(), Date.now(), input.userId, input.id);
  return readTranscriptHistoryRecord({ id: input.id, userId: input.userId });
}

export function updateTranscriptHistoryRecordTranscript(input: {
  id: string;
  transcriptContent: string;
  transcriptSegments?: unknown;
  userId: string;
}): TranscriptHistoryRecord | null {
  const result = getTranscriptDb()
    .prepare(
      `UPDATE transcript_history_records
       SET transcript_content = ?, transcript_segments_json = ?, updated_at = ?
       WHERE user_id = ? AND id = ?`,
    )
    .run(
      input.transcriptContent,
      input.transcriptSegments === undefined ? null : JSON.stringify(input.transcriptSegments),
      Date.now(),
      input.userId,
      input.id,
    );
  return result.changes > 0 ? readTranscriptHistoryRecord({ id: input.id, userId: input.userId }) : null;
}

export function deleteTranscriptHistoryRecord(input: {
  id: string;
  userId: string;
}): boolean {
  const result = getTranscriptDb()
    .prepare("DELETE FROM transcript_history_records WHERE user_id = ? AND id = ?")
    .run(input.userId, input.id);
  return result.changes > 0;
}

export function insertTranscriptHistorySummary(input: {
  content: string;
  historyRecordId: string;
  id: string;
  promptId: string;
  promptTitle: string;
  userId: string;
}): TranscriptHistorySummary {
  const now = Date.now();
  getTranscriptDb()
    .prepare(
      `INSERT INTO transcript_history_summaries (
         id, history_record_id, user_id, prompt_id, prompt_title, content, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.historyRecordId,
      input.userId,
      input.promptId,
      input.promptTitle,
      input.content,
      now,
    );
  const summary = readTranscriptHistorySummary({
    historyRecordId: input.historyRecordId,
    id: input.id,
    userId: input.userId,
  });
  if (!summary) {
    throw new Error("AI 总结历史保存失败。");
  }
  return summary;
}

export function listTranscriptHistorySummaries(input: {
  historyRecordId: string;
  userId: string;
}): TranscriptHistorySummary[] {
  const rows = getTranscriptDb()
    .prepare(
      `SELECT id, prompt_id, prompt_title, content, created_at
       FROM transcript_history_summaries
       WHERE user_id = ? AND history_record_id = ?
       ORDER BY created_at DESC`,
    )
    .all(input.userId, input.historyRecordId) as TranscriptHistorySummaryRow[];
  return rows.map(mapTranscriptHistorySummary);
}

export function readTranscriptHistorySummary(input: {
  historyRecordId: string;
  id: string;
  userId: string;
}): TranscriptHistorySummary | null {
  const row = getTranscriptDb()
    .prepare(
      `SELECT id, prompt_id, prompt_title, content, created_at
       FROM transcript_history_summaries
       WHERE user_id = ? AND history_record_id = ? AND id = ?
       LIMIT 1`,
    )
    .get(input.userId, input.historyRecordId, input.id) as TranscriptHistorySummaryRow | undefined;
  return row ? mapTranscriptHistorySummary(row) : null;
}

export function nextAsrQuotaResetAt(now = Date.now()): number {
  return startOfNextLocalDay(now);
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_asr_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      work_key TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      model TEXT,
      audio_duration_seconds REAL NOT NULL DEFAULT 0,
      history_record_id TEXT,
      history_work_json TEXT,
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

    CREATE TABLE IF NOT EXISTS transcript_asr_job_cancellations (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(id, user_id)
    );

    CREATE TABLE IF NOT EXISTS transcript_history_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      work_key TEXT NOT NULL,
      work_id TEXT NOT NULL,
      work_kind TEXT NOT NULL,
      input_url TEXT NOT NULL,
      final_url TEXT NOT NULL,
      author_name TEXT,
      original_title TEXT NOT NULL,
      display_title TEXT NOT NULL,
      duration_seconds REAL,
      transcript_content TEXT NOT NULL,
      transcript_segments_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS transcript_history_records_user_updated_idx
      ON transcript_history_records(user_id, updated_at);

    CREATE INDEX IF NOT EXISTS transcript_history_records_user_work_idx
      ON transcript_history_records(user_id, work_key, updated_at);

    CREATE TABLE IF NOT EXISTS transcript_history_summaries (
      id TEXT PRIMARY KEY,
      history_record_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      prompt_title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(history_record_id) REFERENCES transcript_history_records(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS transcript_history_summaries_record_idx
      ON transcript_history_summaries(user_id, history_record_id, created_at);
  `);
  ensureColumn(db, "transcript_asr_tasks", "model", "TEXT");
  ensureColumn(db, "transcript_asr_tasks", "audio_duration_seconds", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "transcript_asr_tasks", "history_record_id", "TEXT");
  ensureColumn(db, "transcript_asr_tasks", "history_work_json", "TEXT");
}

const HISTORY_RECORD_COLUMNS = `
  id, user_id, work_key, work_id, work_kind, input_url, final_url,
  author_name, original_title, display_title, duration_seconds,
  transcript_content, transcript_segments_json, created_at, updated_at
`;

const ASR_TASK_COLUMNS = `
  id, user_id, work_key, cache_key, task_id, object_key, model,
  audio_duration_seconds, history_record_id, history_work_json,
  status, error_detail, updated_at
`;

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
    historyContext: mapAsrHistoryContext(row),
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

function mapAsrHistoryContext(row: StoredAsrTaskRow): StoredAsrHistoryContext | undefined {
  if (!row.history_record_id || !row.history_work_json) {
    return undefined;
  }
  try {
    return {
      historyRecordId: row.history_record_id,
      work: JSON.parse(row.history_work_json) as unknown,
    };
  } catch {
    return undefined;
  }
}

function mapTranscriptHistoryRecord(row: TranscriptHistoryRecordRow): TranscriptHistoryRecord {
  return {
    authorName: row.author_name ?? undefined,
    createdAt: row.created_at,
    displayTitle: row.display_title,
    durationSeconds: row.duration_seconds ?? undefined,
    finalUrl: row.final_url,
    id: row.id,
    inputUrl: row.input_url,
    originalTitle: row.original_title,
    transcriptContent: row.transcript_content,
    transcriptSegments: row.transcript_segments_json ? JSON.parse(row.transcript_segments_json) as unknown : undefined,
    updatedAt: row.updated_at,
    userId: row.user_id,
    workId: row.work_id,
    workKey: row.work_key,
    workKind: row.work_kind,
  };
}

function mapTranscriptHistorySummary(row: TranscriptHistorySummaryRow): TranscriptHistorySummary {
  return {
    content: row.content,
    createdAt: row.created_at,
    id: row.id,
    promptId: row.prompt_id,
    promptTitle: row.prompt_title,
  };
}

function normalizeHistoryTitle(title: string | undefined, fallbackUrl: string): string {
  return title?.trim() || fallbackUrl;
}

function startOfLocalDay(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfNextLocalDay(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}
