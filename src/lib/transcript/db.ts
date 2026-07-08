import { execute, queryRow, queryRows } from "@/lib/storage/postgres";

type StoredAsrTaskRow = {
  audio_duration_seconds: number | null;
  cache_key: string;
  error_detail: string | null;
  history_record_id: string | null;
  history_work: unknown;
  id: string;
  model: string;
  object_key: string;
  status: StoredAsrTaskStatus;
  task_id: string;
  updated_at: number;
  user_id: string;
  work_key: string;
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
  transcript_segments: unknown;
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
type TranscriptCustomPromptRow = {
  created_at: number;
  description: string;
  id: string;
  prompt: string;
  title: string;
  updated_at: number;
  user_id: string;
};

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
export type TranscriptCustomPrompt = {
  createdAt: number;
  description: string;
  id: string;
  prompt: string;
  title: string;
  updatedAt: number;
  userId: string;
};

const HISTORY_RECORD_COLUMNS = `
  id, user_id, work_key, work_id, work_kind, input_url, final_url,
  author_name, original_title, display_title, duration_seconds,
  transcript_content, transcript_segments, created_at, updated_at
`;

const ASR_TASK_COLUMNS = `
  id, user_id, work_key, cache_key, task_id, object_key, model,
  audio_duration_seconds, history_record_id, history_work,
  status, error_detail, updated_at
`;

const SHANGHAI_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function upsertAsrAudioCache(input: {
  durationSeconds: number;
  objectKey: string;
  userId: string;
  workKey: string;
}): Promise<void> {
  const now = Date.now();
  await execute(
    `INSERT INTO transcript_asr_audio_cache (
       user_id, work_key, object_key, duration_seconds, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT(user_id, work_key, object_key) DO UPDATE SET
       duration_seconds = excluded.duration_seconds,
       updated_at = excluded.updated_at`,
    [input.userId, input.workKey, input.objectKey, input.durationSeconds, now],
  );
}

export async function insertAsrTask(input: {
  audioDurationSeconds: number;
  cacheKey: string;
  historyContext?: StoredAsrHistoryContext;
  id: string;
  model: string;
  objectKey: string;
  taskId: string;
  userId: string;
  workKey: string;
}): Promise<void> {
  const now = Date.now();
  await execute(
    `INSERT INTO transcript_asr_tasks (
       id, user_id, work_key, cache_key, task_id, object_key, model,
       audio_duration_seconds, history_record_id, history_work, status, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'running', $11, $11)`,
    [
      input.id,
      input.userId,
      input.workKey,
      input.cacheKey,
      input.taskId,
      input.objectKey,
      input.model,
      input.audioDurationSeconds,
      input.historyContext?.historyRecordId ?? null,
      stringifyJson(input.historyContext?.work),
      now,
    ],
  );
}

export async function reserveAsrTask(input: {
  audioDurationSeconds: number;
  cacheKey: string;
  historyContext?: StoredAsrHistoryContext;
  id: string;
  model: string;
  objectKey: string;
  userId: string;
  workKey: string;
}): Promise<void> {
  await insertAsrTask({
    ...input,
    taskId: `pending:${input.id}`,
  });
}

export async function attachAsrTaskProviderTask(input: {
  id: string;
  taskId: string;
}): Promise<boolean> {
  const row = await queryRow<{ id: string }>(
    `UPDATE transcript_asr_tasks
     SET task_id = $1, updated_at = $2
     WHERE id = $3 AND status = 'running'
     RETURNING id`,
    [input.taskId, Date.now(), input.id],
  );
  return Boolean(row);
}

export async function readRunningAsrTask(input: {
  cacheKey: string;
  userId: string;
}): Promise<StoredAsrTask | null> {
  const row = await queryRow<StoredAsrTaskRow>(
    `SELECT ${ASR_TASK_COLUMNS}
     FROM transcript_asr_tasks
     WHERE user_id = $1 AND cache_key = $2 AND status = 'running'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [input.userId, input.cacheKey],
  );
  return row ? mapAsrTask(row) : null;
}

export async function readAsrTask(input: {
  id: string;
  userId: string;
}): Promise<StoredAsrTask | null> {
  const row = await queryRow<StoredAsrTaskRow>(
    `SELECT ${ASR_TASK_COLUMNS}
     FROM transcript_asr_tasks
     WHERE user_id = $1 AND id = $2
     LIMIT 1`,
    [input.userId, input.id],
  );
  return row ? mapAsrTask(row) : null;
}

export async function markAsrTaskRunning(id: string): Promise<void> {
  await execute(
    `UPDATE transcript_asr_tasks
     SET updated_at = $1
     WHERE id = $2 AND status = 'running'`,
    [Date.now(), id],
  );
}

export async function markAsrTaskSucceeded(id: string): Promise<void> {
  const now = Date.now();
  await execute(
    `UPDATE transcript_asr_tasks
     SET status = 'succeeded', updated_at = $1, completed_at = $1
     WHERE id = $2`,
    [now, id],
  );
}

export async function markAsrTaskFailed(id: string, detail: string): Promise<void> {
  const now = Date.now();
  await execute(
    `UPDATE transcript_asr_tasks
     SET status = 'failed', error_detail = $1, updated_at = $2, completed_at = $2
     WHERE id = $3`,
    [detail, now, id],
  );
}

export async function markAsrTaskCanceled(id: string, detail = "用户已放弃当前转录任务。"): Promise<void> {
  const now = Date.now();
  await execute(
    `UPDATE transcript_asr_tasks
     SET status = 'canceled', error_detail = $1, updated_at = $2, completed_at = $2
     WHERE id = $3 AND status = 'running'`,
    [detail, now, id],
  );
}

export async function readDailySucceededAsrDurationSeconds(input: {
  now?: number;
  userId: string;
}): Promise<number> {
  const now = input.now ?? Date.now();
  const row = await queryRow<{ total: number | null }>(
    `SELECT COALESCE(SUM(audio_duration_seconds), 0)::double precision AS total
     FROM transcript_asr_tasks
     WHERE user_id = $1
       AND status = 'succeeded'
       AND completed_at >= $2
       AND completed_at < $3`,
    [input.userId, startOfLocalDay(now), startOfNextLocalDay(now)],
  );
  return Number(row?.total ?? 0);
}

export async function upsertTranscriptHistoryRecord(input: {
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
}): Promise<TranscriptHistoryRecord> {
  const now = Date.now();
  const title = normalizeHistoryTitle(input.originalTitle, input.finalUrl);
  const row = await queryRow<TranscriptHistoryRecordRow>(
    `INSERT INTO transcript_history_records (
       id, user_id, work_key, work_id, work_kind, input_url, final_url,
       author_name, original_title, display_title, duration_seconds,
       transcript_content, transcript_segments, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $14)
     ON CONFLICT(id) DO UPDATE SET
       input_url = excluded.input_url,
       final_url = excluded.final_url,
       author_name = excluded.author_name,
       original_title = excluded.original_title,
       duration_seconds = excluded.duration_seconds,
       transcript_content = excluded.transcript_content,
       transcript_segments = excluded.transcript_segments,
       updated_at = excluded.updated_at
     RETURNING ${HISTORY_RECORD_COLUMNS}`,
    [
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
      stringifyJson(input.transcriptSegments),
      now,
    ],
  );
  if (!row) {
    throw new Error("转录历史保存失败。");
  }
  return mapTranscriptHistoryRecord(row);
}

export async function listTranscriptHistoryRecords(input: {
  limit?: number;
  query?: string;
  userId: string;
}): Promise<TranscriptHistoryRecord[]> {
  const limit = Math.min(Math.max(input.limit ?? 80, 1), 200);
  const query = input.query?.trim();
  const rows = query
    ? await queryRows<TranscriptHistoryRecordRow>(
        `SELECT ${HISTORY_RECORD_COLUMNS}
         FROM transcript_history_records
         WHERE user_id = $1 AND transcript_content <> '' AND display_title ILIKE $2
         ORDER BY updated_at DESC
         LIMIT $3`,
        [input.userId, `%${query}%`, limit],
      )
    : await queryRows<TranscriptHistoryRecordRow>(
        `SELECT ${HISTORY_RECORD_COLUMNS}
         FROM transcript_history_records
         WHERE user_id = $1 AND transcript_content <> ''
         ORDER BY updated_at DESC
         LIMIT $2`,
        [input.userId, limit],
      );
  return rows.map(mapTranscriptHistoryRecord);
}

export async function readTranscriptHistoryRecord(input: {
  id: string;
  userId: string;
}): Promise<TranscriptHistoryRecord | null> {
  const row = await queryRow<TranscriptHistoryRecordRow>(
    `SELECT ${HISTORY_RECORD_COLUMNS}
     FROM transcript_history_records
     WHERE user_id = $1 AND id = $2
     LIMIT 1`,
    [input.userId, input.id],
  );
  return row ? mapTranscriptHistoryRecord(row) : null;
}

export async function renameTranscriptHistoryRecord(input: {
  displayTitle: string;
  id: string;
  userId: string;
}): Promise<TranscriptHistoryRecord | null> {
  const row = await queryRow<TranscriptHistoryRecordRow>(
    `UPDATE transcript_history_records
     SET display_title = $1, updated_at = $2
     WHERE user_id = $3 AND id = $4
     RETURNING ${HISTORY_RECORD_COLUMNS}`,
    [input.displayTitle, Date.now(), input.userId, input.id],
  );
  return row ? mapTranscriptHistoryRecord(row) : null;
}

export async function updateTranscriptHistoryRecordTranscript(input: {
  id: string;
  transcriptContent: string;
  transcriptSegments?: unknown;
  userId: string;
}): Promise<TranscriptHistoryRecord | null> {
  const row = await queryRow<TranscriptHistoryRecordRow>(
    `UPDATE transcript_history_records
     SET transcript_content = $1, transcript_segments = $2::jsonb, updated_at = $3
     WHERE user_id = $4 AND id = $5
     RETURNING ${HISTORY_RECORD_COLUMNS}`,
    [
      input.transcriptContent,
      stringifyJson(input.transcriptSegments),
      Date.now(),
      input.userId,
      input.id,
    ],
  );
  return row ? mapTranscriptHistoryRecord(row) : null;
}

export async function deleteTranscriptHistoryRecord(input: {
  id: string;
  userId: string;
}): Promise<boolean> {
  const rowCount = await execute(
    "DELETE FROM transcript_history_records WHERE user_id = $1 AND id = $2",
    [input.userId, input.id],
  );
  return rowCount > 0;
}

export async function insertTranscriptHistorySummary(input: {
  content: string;
  historyRecordId: string;
  id: string;
  promptId: string;
  promptTitle: string;
  userId: string;
}): Promise<TranscriptHistorySummary> {
  const now = Date.now();
  const row = await queryRow<TranscriptHistorySummaryRow>(
    `INSERT INTO transcript_history_summaries (
       id, history_record_id, user_id, prompt_id, prompt_title, content, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, prompt_id, prompt_title, content, created_at`,
    [input.id, input.historyRecordId, input.userId, input.promptId, input.promptTitle, input.content, now],
  );
  if (!row) {
    throw new Error("转录总结保存失败。");
  }
  return mapTranscriptHistorySummary(row);
}

export async function listTranscriptHistorySummaries(input: {
  historyRecordId: string;
  userId: string;
}): Promise<TranscriptHistorySummary[]> {
  const rows = await queryRows<TranscriptHistorySummaryRow>(
    `SELECT id, prompt_id, prompt_title, content, created_at
     FROM transcript_history_summaries
     WHERE user_id = $1 AND history_record_id = $2
     ORDER BY created_at DESC`,
    [input.userId, input.historyRecordId],
  );
  return rows.map(mapTranscriptHistorySummary);
}

export async function readTranscriptHistorySummary(input: {
  historyRecordId: string;
  id: string;
  userId: string;
}): Promise<TranscriptHistorySummary | null> {
  const row = await queryRow<TranscriptHistorySummaryRow>(
    `SELECT id, prompt_id, prompt_title, content, created_at
     FROM transcript_history_summaries
     WHERE user_id = $1 AND history_record_id = $2 AND id = $3
     LIMIT 1`,
    [input.userId, input.historyRecordId, input.id],
  );
  return row ? mapTranscriptHistorySummary(row) : null;
}

export async function deleteTranscriptHistorySummary(input: {
  historyRecordId: string;
  id: string;
  userId: string;
}): Promise<boolean> {
  const rowCount = await execute(
    "DELETE FROM transcript_history_summaries WHERE user_id = $1 AND history_record_id = $2 AND id = $3",
    [input.userId, input.historyRecordId, input.id],
  );
  return rowCount > 0;
}

export async function listTranscriptCustomPrompts(input: {
  userId: string;
}): Promise<TranscriptCustomPrompt[]> {
  const rows = await queryRows<TranscriptCustomPromptRow>(
    `SELECT id, user_id, title, description, prompt, created_at, updated_at
     FROM transcript_custom_prompts
     WHERE user_id = $1
     ORDER BY created_at ASC`,
    [input.userId],
  );
  return rows.map(mapTranscriptCustomPrompt);
}

export async function insertTranscriptCustomPrompt(input: {
  description?: string;
  id: string;
  prompt: string;
  title: string;
  userId: string;
}): Promise<TranscriptCustomPrompt> {
  const now = Date.now();
  const row = await queryRow<TranscriptCustomPromptRow>(
    `INSERT INTO transcript_custom_prompts (
       id, user_id, title, description, prompt, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING id, user_id, title, description, prompt, created_at, updated_at`,
    [
      input.id,
      input.userId,
      input.title.trim(),
      input.description?.trim() || input.prompt.trim(),
      input.prompt.trim(),
      now,
    ],
  );
  if (!row) {
    throw new Error("自定义提示词保存失败。");
  }
  return mapTranscriptCustomPrompt(row);
}

export async function updateTranscriptCustomPrompt(input: {
  id: string;
  prompt: string;
  title: string;
  userId: string;
}): Promise<TranscriptCustomPrompt | null> {
  const cleanPrompt = input.prompt.trim();
  const row = await queryRow<TranscriptCustomPromptRow>(
    `UPDATE transcript_custom_prompts
     SET title = $1, description = $2, prompt = $3, updated_at = $4
     WHERE user_id = $5 AND id = $6
     RETURNING id, user_id, title, description, prompt, created_at, updated_at`,
    [
      input.title.trim(),
      cleanPrompt,
      cleanPrompt,
      Date.now(),
      input.userId,
      input.id,
    ],
  );
  return row ? mapTranscriptCustomPrompt(row) : null;
}

export async function deleteTranscriptCustomPrompt(input: {
  id: string;
  userId: string;
}): Promise<boolean> {
  const rowCount = await execute(
    "DELETE FROM transcript_custom_prompts WHERE user_id = $1 AND id = $2",
    [input.userId, input.id],
  );
  return rowCount > 0;
}

export async function readTranscriptCustomPrompt(input: {
  id: string;
  userId: string;
}): Promise<TranscriptCustomPrompt | null> {
  const row = await queryRow<TranscriptCustomPromptRow>(
    `SELECT id, user_id, title, description, prompt, created_at, updated_at
     FROM transcript_custom_prompts
     WHERE user_id = $1 AND id = $2
     LIMIT 1`,
    [input.userId, input.id],
  );
  return row ? mapTranscriptCustomPrompt(row) : null;
}

export function nextAsrQuotaResetAt(now = Date.now()): number {
  return startOfNextLocalDay(now);
}

function mapAsrTask(row: StoredAsrTaskRow): StoredAsrTask {
  return {
    audioDurationSeconds: row.audio_duration_seconds ?? 0,
    cacheKey: row.cache_key,
    errorDetail: row.error_detail ?? undefined,
    historyContext: mapAsrHistoryContext(row),
    id: row.id,
    model: row.model,
    objectKey: row.object_key,
    status: row.status,
    taskId: row.task_id,
    updatedAt: row.updated_at,
    userId: row.user_id,
    workKey: row.work_key,
  };
}

function mapAsrHistoryContext(row: StoredAsrTaskRow): StoredAsrHistoryContext | undefined {
  if (!row.history_record_id || row.history_work === null || row.history_work === undefined) {
    return undefined;
  }
  return {
    historyRecordId: row.history_record_id,
    work: parseJsonValue(row.history_work),
  };
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
    transcriptSegments: parseJsonValue(row.transcript_segments) ?? undefined,
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

function mapTranscriptCustomPrompt(row: TranscriptCustomPromptRow): TranscriptCustomPrompt {
  return {
    createdAt: row.created_at,
    description: row.description,
    id: row.id,
    prompt: row.prompt,
    title: row.title,
    updatedAt: row.updated_at,
    userId: row.user_id,
  };
}

function normalizeHistoryTitle(title: string | undefined, fallbackUrl: string): string {
  return title?.trim() || fallbackUrl;
}

function stringifyJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function startOfLocalDay(now: number): number {
  return Math.floor((now + SHANGHAI_TIME_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_TIME_OFFSET_MS;
}

function startOfNextLocalDay(now: number): number {
  return startOfLocalDay(now) + DAY_MS;
}
