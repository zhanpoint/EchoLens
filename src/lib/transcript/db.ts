import type { TranscribeHistoryContext } from "@/lib/douyin/transcribe-request";
import type { ProviderResult } from "@/lib/ai/provider-result";
import { TranscribeHistoryContextSchema } from "@/lib/douyin/transcribe-schema";
import { execute, queryRow, queryRows, withTransaction, type DbExecutor } from "@/lib/storage/postgres";

type StoredAsrTaskRow = {
  audio_duration_seconds: number | null;
  cache_key: string;
  credential_source: AsrCredentialSource;
  error_detail: string | null;
  history_record_id: string | null;
  history_work: unknown;
  result: Extract<ProviderResult, { ok: true }> | null;
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
  author_url: string | null;
  avatar_url: string | null;
  caption: string | null;
  cover_url: string | null;
  created_at: number;
  dubbing_url: string | null;
  duration_seconds: number | null;
  final_url: string;
  id: string;
  input_url: string;
  media_quality: string | null;
  original_audio: string | null;
  pinned_at: number | null;
  source_metadata_refreshed_at: number | null;
  source_urls_expires_at: number | null;
  session_name: string;
  transcript_content: string;
  transcript_segments: unknown;
  updated_at: number;
  user_id: string;
  video_url: string | null;
  dash_video_url: string | null;
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
export type AsrCredentialSource = "platform" | "custom";
export type StoredAsrTask = {
  audioDurationSeconds: number;
  cacheKey: string;
  credentialSource: AsrCredentialSource;
  errorDetail?: string;
  historyContext?: StoredAsrHistoryContext;
  result?: Extract<ProviderResult, { ok: true }>;
  id: string;
  model: string;
  objectKey: string;
  status: StoredAsrTaskStatus;
  taskId: string;
  updatedAt: number;
  userId: string;
  workKey: string;
};
export type StoredAsrHistoryContext = TranscribeHistoryContext;
export type TranscriptHistoryRecord = {
  authorName?: string;
  authorUrl?: string;
  avatarUrl?: string;
  caption: string;
  coverUrl?: string;
  createdAt: number;
  dubbingUrl?: string;
  sessionName: string;
  durationSeconds?: number;
  finalUrl: string;
  id: string;
  inputUrl: string;
  mediaQuality?: string;
  originalAudio?: string;
  pinnedAt?: number;
  sourceMetadataRefreshedAt?: number;
  sourceUrlsExpiresAt?: number;
  dashVideoUrl?: string;
  transcriptContent: string;
  transcriptSegments?: unknown;
  updatedAt: number;
  userId: string;
  videoUrl?: string;
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

const HISTORY_METADATA_COLUMNS = `
  id, user_id, work_key, work_id, work_kind, input_url, final_url,
  author_name, author_url, avatar_url, caption, cover_url, session_name,
  duration_seconds, dubbing_url, video_url, dash_video_url, media_quality,
  original_audio, source_metadata_refreshed_at, source_urls_expires_at,
  created_at, updated_at, pinned_at
`;
const HISTORY_RECORD_COLUMNS = `${HISTORY_METADATA_COLUMNS}, transcript_content, transcript_segments`;
const HISTORY_LIST_COLUMNS = `${HISTORY_METADATA_COLUMNS}, ''::text AS transcript_content, NULL::jsonb AS transcript_segments`;

const ASR_TASK_COLUMNS = `
  id, user_id, work_key, cache_key, task_id, object_key, model, credential_source,
  audio_duration_seconds, history_record_id, history_work,
  status, error_detail, result, updated_at
`;

export async function insertAsrTask(input: {
  audioDurationSeconds: number;
  cacheKey: string;
  credentialSource?: AsrCredentialSource;
  historyContext?: StoredAsrHistoryContext;
  id: string;
  model: string;
  objectKey: string;
  taskId: string;
  userId: string;
  workKey: string;
}): Promise<void> {
  await insertAsrTaskWithExecutor(input);
}

async function insertAsrTaskWithExecutor(input: {
  audioDurationSeconds: number;
  cacheKey: string;
  credentialSource?: AsrCredentialSource;
  historyContext?: StoredAsrHistoryContext;
  id: string;
  model: string;
  objectKey: string;
  taskId: string;
  userId: string;
  workKey: string;
}, executor?: DbExecutor): Promise<void> {
  const now = Date.now();
  await execute(
    `INSERT INTO transcript_asr_tasks (
       id, user_id, work_key, cache_key, task_id, object_key, model, credential_source,
       audio_duration_seconds, history_record_id, history_work, status, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'running', $12)`,
    [
      input.id,
      input.userId,
      input.workKey,
      input.cacheKey,
      input.taskId,
      input.objectKey,
      input.model,
      input.credentialSource ?? "platform",
      input.audioDurationSeconds,
      input.historyContext?.historyRecordId ?? null,
      stringifyJson(input.historyContext?.work),
      now,
    ],
    executor,
  );
}

export async function reserveAsrTask(input: {
  audioDurationSeconds: number;
  cacheKey: string;
  credentialSource: AsrCredentialSource;
  historyContext?: StoredAsrHistoryContext;
  id: string;
  model: string;
  objectKey: string;
  userId: string;
  workKey: string;
}, platformQuotaLimitSeconds?: number): Promise<boolean> {
  const reservedInput = { ...input, taskId: `pending:${input.id}` };
  if (input.credentialSource !== "platform" || platformQuotaLimitSeconds === undefined) {
    await insertAsrTaskWithExecutor(reservedInput);
    return true;
  }

  return await withTransaction(async (transaction) => {
    await queryRow(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [input.userId],
      transaction,
    );
    const usedSeconds = await readPlatformAsrQuotaUsageSeconds({ userId: input.userId }, transaction);
    if (usedSeconds + input.audioDurationSeconds > platformQuotaLimitSeconds) {
      return false;
    }
    await insertAsrTaskWithExecutor(reservedInput, transaction);
    return true;
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

export async function checkpointAsrTaskResult(id: string, result: Extract<ProviderResult, { ok: true }>): Promise<boolean> {
  return (await execute(
    "UPDATE transcript_asr_tasks SET result = $2::jsonb, updated_at = $3 WHERE id = $1 AND status = 'running'",
    [id, JSON.stringify(result), Date.now()],
  )) > 0;
}

export async function markAsrTaskSucceeded(id: string, result?: Extract<ProviderResult, { ok: true }>): Promise<boolean> {
  const now = Date.now();
  const rowCount = await execute(
    `UPDATE transcript_asr_tasks
     SET status = 'succeeded', updated_at = $1, result = $3::jsonb
     WHERE id = $2 AND status = 'running'`,
    [now, id, result ? JSON.stringify(result) : null],
  );
  return rowCount > 0;
}

export async function deleteAsrTask(input: { id: string; userId: string }): Promise<boolean> {
  const rowCount = await execute(
    "DELETE FROM transcript_asr_tasks WHERE user_id = $1 AND id = $2 AND status = 'canceled'",
    [input.userId, input.id],
  );
  return rowCount > 0;
}

export async function markAsrTaskFailed(id: string, detail: string): Promise<void> {
  const now = Date.now();
  await execute(
    `UPDATE transcript_asr_tasks
     SET status = 'failed', error_detail = $1, updated_at = $2
     WHERE id = $3`,
    [detail, now, id],
  );
}

export async function markAsrTaskCanceled(id: string, detail = "用户已放弃当前转录任务。"): Promise<void> {
  const now = Date.now();
  await execute(
    `UPDATE transcript_asr_tasks
     SET status = 'canceled', error_detail = $1, updated_at = $2
     WHERE id = $3 AND status = 'running'`,
    [detail, now, id],
  );
}

export async function reserveOpenApiAsrQuota(input: {
  durationSeconds: number;
  limitSeconds: number;
  userId: string;
}): Promise<boolean> {
  return await withTransaction(async (transaction) => {
    await queryRow(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [input.userId],
      transaction,
    );
    const usedSeconds = await readPlatformAsrQuotaUsageSeconds({ userId: input.userId }, transaction);
    if (usedSeconds + input.durationSeconds > input.limitSeconds) return false;

    await execute(
      `INSERT INTO transcript_open_api_quota_usage (user_id, used_seconds, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(user_id) DO UPDATE SET
         used_seconds = transcript_open_api_quota_usage.used_seconds + excluded.used_seconds,
         updated_at = excluded.updated_at`,
      [input.userId, input.durationSeconds, Date.now()],
      transaction,
    );
    return true;
  });
}

export async function releaseOpenApiAsrQuota(input: {
  durationSeconds: number;
  userId: string;
}): Promise<void> {
  await execute(
    `UPDATE transcript_open_api_quota_usage
     SET used_seconds = CASE
           WHEN used_seconds > $1 THEN used_seconds - $1
           ELSE 0
         END,
         updated_at = $2
     WHERE user_id = $3`,
    [input.durationSeconds, Date.now(), input.userId],
  );
}

export async function readPlatformAsrQuotaUsageSeconds(input: {
  userId: string;
}, executor?: DbExecutor): Promise<number> {
  const row = await queryRow<{ total: number | null }>(
    `SELECT (
       SELECT COALESCE(SUM(audio_duration_seconds), 0)
       FROM transcript_asr_tasks
       WHERE user_id = $1
         AND status IN ('running', 'succeeded')
         AND credential_source = 'platform'
     ) + (
       SELECT COALESCE(SUM(used_seconds), 0)
       FROM transcript_open_api_quota_usage
       WHERE user_id = $1
     ) AS total`,
    [input.userId],
    executor,
  );
  return Number(row?.total ?? 0);
}

export type TranscriptHistoryRecordInput = {
  authorName?: string;
  authorUrl?: string;
  avatarUrl?: string;
  caption: string;
  coverUrl?: string;
  sessionName?: string;
  durationSeconds?: number;
  dubbingUrl?: string;
  finalUrl: string;
  id: string;
  inputUrl: string;
  mediaQuality?: string;
  originalAudio?: string;
  sourceMetadataRefreshedAt?: number;
  sourceUrlsExpiresAt?: number;
  dashVideoUrl?: string;
  transcriptContent: string;
  transcriptSegments?: unknown;
  userId: string;
  videoUrl?: string;
  workId: string;
  workKey: string;
  workKind: string;
};

export async function findOrCreateTranscriptHistoryRecord(
  input: TranscriptHistoryRecordInput,
): Promise<{ created: boolean; record: TranscriptHistoryRecord }> {
  const row = await writeTranscriptHistoryRecord(input, "work");
  return {
    created: row.id === input.id,
    record: mapTranscriptHistoryRecord(row),
  };
}

export async function upsertTranscriptHistoryRecord(
  input: TranscriptHistoryRecordInput,
): Promise<TranscriptHistoryRecord> {
  return mapTranscriptHistoryRecord(await writeTranscriptHistoryRecord(input, "id"));
}

async function writeTranscriptHistoryRecord(
  input: TranscriptHistoryRecordInput,
  conflictKey: "id" | "work",
): Promise<TranscriptHistoryRecordRow> {
  const now = Date.now();
  const title = requireHistoryCaption(input.caption);
  const commonUpdates = `
         input_url = excluded.input_url,
         final_url = excluded.final_url,
         author_name = excluded.author_name,
         author_url = excluded.author_url,
         avatar_url = COALESCE(excluded.avatar_url, transcript_history_records.avatar_url),
         caption = excluded.caption,
         cover_url = COALESCE(excluded.cover_url, transcript_history_records.cover_url),
         duration_seconds = excluded.duration_seconds,
         dubbing_url = COALESCE(excluded.dubbing_url, transcript_history_records.dubbing_url),
         video_url = COALESCE(excluded.video_url, transcript_history_records.video_url),
         dash_video_url = COALESCE(excluded.dash_video_url, transcript_history_records.dash_video_url),
         media_quality = COALESCE(excluded.media_quality, transcript_history_records.media_quality),
         original_audio = COALESCE(excluded.original_audio, transcript_history_records.original_audio),
         source_metadata_refreshed_at = excluded.source_metadata_refreshed_at,
         source_urls_expires_at = excluded.source_urls_expires_at`;
  const conflictClause = conflictKey === "work"
    ? `ON CONFLICT(user_id, work_key) DO UPDATE SET${commonUpdates},
         updated_at = excluded.updated_at`
    : `ON CONFLICT(id) DO UPDATE SET${commonUpdates},
         transcript_content = excluded.transcript_content,
         transcript_segments = excluded.transcript_segments,
         updated_at = excluded.updated_at
       WHERE transcript_history_records.user_id = excluded.user_id`;
  const row = await queryRow<TranscriptHistoryRecordRow>(
    `INSERT INTO transcript_history_records (
       id, user_id, work_key, work_id, work_kind, input_url, final_url,
       author_name, author_url, avatar_url, caption, cover_url, session_name,
       duration_seconds, dubbing_url, video_url, dash_video_url, media_quality,
       original_audio, source_metadata_refreshed_at, source_urls_expires_at,
       transcript_content, transcript_segments, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb, $24, $24)
     ${conflictClause}
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
      input.authorUrl ?? null,
      input.avatarUrl ?? null,
      title,
      input.coverUrl ?? null,
      input.sessionName?.trim() || title,
      input.durationSeconds ?? null,
      input.dubbingUrl ?? null,
      input.videoUrl ?? null,
      input.dashVideoUrl ?? null,
      input.mediaQuality ?? null,
      input.originalAudio ?? null,
      input.sourceMetadataRefreshedAt ?? now,
      input.sourceUrlsExpiresAt ?? null,
      input.transcriptContent,
      stringifyJson(input.transcriptSegments),
      now,
    ],
  );
  if (!row || row.user_id !== input.userId) {
    throw new Error(conflictKey === "work" ? "转录历史创建失败。" : "转录历史保存失败。");
  }
  return row;
}

export async function updateTranscriptHistoryRecordMetadata(input: {
  authorName?: string;
  authorUrl?: string;
  avatarUrl?: string;
  caption: string;
  coverUrl?: string;
  dashVideoUrl?: string;
  dubbingUrl?: string;
  durationSeconds?: number;
  historyRecordId: string;
  mediaQuality?: string;
  originalAudio?: string;
  sourceMetadataRefreshedAt?: number;
  sourceUrlsExpiresAt?: number;
  userId: string;
  videoUrl?: string;
}): Promise<TranscriptHistoryRecord | null> {
  const caption = requireHistoryCaption(input.caption);
  const refreshedAt = input.sourceMetadataRefreshedAt ?? Date.now();
  const row = await queryRow<TranscriptHistoryRecordRow>(
    `UPDATE transcript_history_records
     SET author_name = COALESCE($1::text, author_name),
         author_url = COALESCE($2::text, author_url),
         avatar_url = $3::text,
         caption = $4::text,
         cover_url = $5::text,
         dash_video_url = $6::text,
         dubbing_url = $7::text,
         duration_seconds = COALESCE($8::double precision, duration_seconds),
         media_quality = $9::text,
         original_audio = COALESCE($10::text, original_audio),
         source_metadata_refreshed_at = $11::bigint,
         source_urls_expires_at = $12::bigint,
         video_url = $13::text,
         updated_at = $14::bigint
     WHERE id = $15::text AND user_id = $16::text
     RETURNING ${HISTORY_RECORD_COLUMNS}`,
    [
      input.authorName ?? null,
      input.authorUrl ?? null,
      input.avatarUrl ?? null,
      caption,
      input.coverUrl ?? null,
      input.dashVideoUrl ?? null,
      input.dubbingUrl ?? null,
      input.durationSeconds ?? null,
      input.mediaQuality ?? null,
      input.originalAudio ?? null,
      refreshedAt,
      input.sourceUrlsExpiresAt ?? null,
      input.videoUrl ?? null,
      Date.now(),
      input.historyRecordId,
      input.userId,
    ],
  );
  return row ? mapTranscriptHistoryRecord(row) : null;
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
        `SELECT ${HISTORY_LIST_COLUMNS}
         FROM transcript_history_records
         WHERE user_id = $1 AND session_name ILIKE $2
         ORDER BY pinned_at IS NULL, updated_at DESC
         LIMIT $3`,
        [input.userId, `%${query}%`, limit],
      )
    : await queryRows<TranscriptHistoryRecordRow>(
        `SELECT ${HISTORY_LIST_COLUMNS}
         FROM transcript_history_records
         WHERE user_id = $1
         ORDER BY pinned_at IS NULL, updated_at DESC
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
  sessionName: string;
  id: string;
  userId: string;
}): Promise<TranscriptHistoryRecord | null> {
  const row = await queryRow<TranscriptHistoryRecordRow>(
    `UPDATE transcript_history_records
     SET session_name = $1
     WHERE user_id = $2 AND id = $3
     RETURNING ${HISTORY_RECORD_COLUMNS}`,
    [input.sessionName, input.userId, input.id],
  );
  return row ? mapTranscriptHistoryRecord(row) : null;
}

export async function setTranscriptHistoryRecordPinned(input: {
  id: string;
  pinned: boolean;
  userId: string;
}): Promise<TranscriptHistoryRecord | null> {
  const row = await queryRow<TranscriptHistoryRecordRow>(
    `UPDATE transcript_history_records
     SET pinned_at = $1
     WHERE user_id = $2 AND id = $3
     RETURNING ${HISTORY_RECORD_COLUMNS}`,
    [input.pinned ? Date.now() : null, input.userId, input.id],
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
       id, history_record_id, prompt_id, prompt_title, content, created_at
     )
     SELECT $1::text, history.id, $3::text, $4::text, $5::text, $6::bigint
     FROM transcript_history_records history
     WHERE history.id = $2::text AND history.user_id = $7::text
     RETURNING id, prompt_id, prompt_title, content, created_at`,
    [input.id, input.historyRecordId, input.promptId, input.promptTitle, input.content, now, input.userId],
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
    `SELECT summary.id, summary.prompt_id, summary.prompt_title, summary.content, summary.created_at
     FROM transcript_history_summaries summary
     JOIN transcript_history_records history ON history.id = summary.history_record_id
     WHERE history.user_id = $1 AND summary.history_record_id = $2
     ORDER BY summary.created_at DESC`,
    [input.userId, input.historyRecordId],
  );
  return rows.map(mapTranscriptHistorySummary);
}

export async function deleteTranscriptHistorySummary(input: {
  historyRecordId: string;
  id: string;
  userId: string;
}): Promise<boolean> {
  const rowCount = await execute(
    `DELETE FROM transcript_history_summaries
     WHERE history_record_id = $2 AND id = $3
       AND history_record_id IN (
         SELECT history.id
         FROM transcript_history_records history
         WHERE history.user_id = $1 AND history.id = $2
       )`,
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

function mapAsrTask(row: StoredAsrTaskRow): StoredAsrTask {
  return {
    audioDurationSeconds: row.audio_duration_seconds ?? 0,
    cacheKey: row.cache_key,
    credentialSource: row.credential_source,
    errorDetail: row.error_detail ?? undefined,
    historyContext: mapAsrHistoryContext(row),
    result: row.result ?? undefined,
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
  const parsed = TranscribeHistoryContextSchema.safeParse({
    historyRecordId: row.history_record_id,
    work: parseJsonValue(row.history_work),
  });
  return parsed.success ? parsed.data : undefined;
}

function mapTranscriptHistoryRecord(row: TranscriptHistoryRecordRow): TranscriptHistoryRecord {
  return {
    authorName: row.author_name ?? undefined,
    authorUrl: row.author_url ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    caption: requireStoredHistoryCaption(row.caption),
    coverUrl: row.cover_url ?? undefined,
    createdAt: row.created_at,
    dubbingUrl: row.dubbing_url ?? undefined,
    sessionName: row.session_name,
    durationSeconds: row.duration_seconds ?? undefined,
    finalUrl: row.final_url,
    id: row.id,
    inputUrl: row.input_url,
    mediaQuality: row.media_quality ?? undefined,
    originalAudio: row.original_audio ?? undefined,
    pinnedAt: row.pinned_at ?? undefined,
    sourceMetadataRefreshedAt: row.source_metadata_refreshed_at ?? undefined,
    sourceUrlsExpiresAt: row.source_urls_expires_at ?? undefined,
    dashVideoUrl: row.dash_video_url ?? undefined,
    transcriptContent: row.transcript_content,
    transcriptSegments: parseJsonValue(row.transcript_segments) ?? undefined,
    updatedAt: row.updated_at,
    userId: row.user_id,
    videoUrl: row.video_url ?? undefined,
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

function requireStoredHistoryCaption(caption: string | null): string {
  if (!caption) {
    throw new Error("历史记录缺少作品标题，请重新检测作品。");
  }
  return caption;
}

function requireHistoryCaption(caption: string): string {
  const value = caption.trim();
  if (!value) {
    throw new Error("作品标题不能为空。");
  }
  return value;
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
