import type { DouyinCommentsPayload } from "@/lib/douyin/comments";
import { execute, queryRow } from "@/lib/storage/postgres";

export type TranscriptHistoryCommentsMetadata = {
  collectedAt: number;
  commentCount: number;
};

type CommentsPayloadRow = {
  payload: DouyinCommentsPayload;
};

type CommentsMetadataRow = {
  collected_at: number | string;
  comment_count: number;
};

export async function readTranscriptHistoryComments(input: {
  historyRecordId: string;
  userId: string;
}): Promise<DouyinCommentsPayload | null> {
  const row = await queryRow<CommentsPayloadRow>(
    `SELECT comments.payload
     FROM transcript_history_comments comments
     JOIN transcript_history_records history ON history.id = comments.history_record_id
     WHERE comments.history_record_id = $1 AND history.user_id = $2`,
    [input.historyRecordId, input.userId],
  );
  return row?.payload ?? null;
}

export async function readTranscriptHistoryCommentsMetadata(input: {
  historyRecordId: string;
  userId: string;
}): Promise<TranscriptHistoryCommentsMetadata | null> {
  const row = await queryRow<CommentsMetadataRow>(
    `SELECT comments.comment_count, comments.collected_at
     FROM transcript_history_comments comments
     JOIN transcript_history_records history ON history.id = comments.history_record_id
     WHERE comments.history_record_id = $1 AND history.user_id = $2`,
    [input.historyRecordId, input.userId],
  );
  return row
    ? { collectedAt: Number(row.collected_at), commentCount: row.comment_count }
    : null;
}

export async function upsertTranscriptHistoryComments(input: {
  historyRecordId: string;
  payload: DouyinCommentsPayload;
  userId: string;
}): Promise<boolean> {
  const affected = await execute(
    `INSERT INTO transcript_history_comments (
       history_record_id, payload, comment_count, collected_at
     )
     SELECT id, $3::jsonb, $4::integer, $5::bigint
     FROM transcript_history_records
     WHERE id = $1 AND user_id = $2
     ON CONFLICT (history_record_id) DO UPDATE SET
       payload = EXCLUDED.payload,
       comment_count = EXCLUDED.comment_count,
       collected_at = EXCLUDED.collected_at`,
    [
      input.historyRecordId,
      input.userId,
      JSON.stringify(input.payload),
      input.payload.commentCount,
      input.payload.collectedAt,
    ],
  );
  return affected === 1;
}