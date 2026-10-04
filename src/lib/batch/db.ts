import { randomUUID } from "node:crypto";
import {
  execute,
  queryRow,
  queryRows,
  withTransaction,
} from "@/lib/storage/postgres";
import type {
  AuthorVideo,
  BatchExportRow,
  BatchDetail,
  BatchItem,
  BatchJob,
  BatchPlatform,
} from "./contracts";
import { videoUrl } from "./contracts";
import { exponentialRetryDelay } from "@/lib/http/retry";

export type CompletedPart = { workId: string; title: string; text: string; skipped?: string };
export type ClaimedItem = {
  id: string;
  batch_id: string;
  user_id: string;
  platform: BatchPlatform;
  model: "e1";
  video: AuthorVideo;
  generation: number;
  retries: number;
  lease_token: string;
  completed_parts: CompletedPart[];
  part_count: number;
  asr_job_id: string | null;
};
const JOB_COLUMNS = `b.id, b.platform, b.author_name AS "authorName", b.model, b.status, b.created_at AS "createdAt",
  COUNT(i.id)::int AS total,
  COALESCE(SUM(CASE WHEN i.status = 'succeeded' THEN 1 ELSE 0 END), 0)::int AS succeeded,
  COALESCE(SUM(CASE WHEN i.status = 'skipped' THEN 1 ELSE 0 END), 0)::int AS skipped,
  COALESCE(SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed,
  COALESCE(SUM(CASE WHEN i.status = 'waiting' OR (i.status = 'processing' AND i.lease_until >= EXTRACT(EPOCH FROM now()) * 1000) THEN 1 ELSE 0 END), 0)::int AS processing,
  COALESCE(SUM(CASE WHEN i.status = 'processing' AND i.lease_until < EXTRACT(EPOCH FROM now()) * 1000 THEN 1 ELSE 0 END), 0)::int AS interrupted,
  COALESCE(SUM(CASE WHEN i.status = 'canceled' THEN 1 ELSE 0 END), 0)::int AS canceled`;

export async function createBatch(
  userId: string,
  input: {
    platform: BatchPlatform;
    authorName: string;
    model: "e1";
    videos: AuthorVideo[];
  },
): Promise<string> {
  const id = randomUUID();
  const videos = [
    ...new Map(
      input.videos.map((video) => {
        videoUrl(input.platform, video.id);
        return [video.id, video] as const;
      }),
    ).values(),
  ];
  await withTransaction(async (client) => {
    await client.query(
      "INSERT INTO transcript_batches (id, user_id, platform, author_name, model, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, userId, input.platform, input.authorName, input.model, Date.now()],
    );
    // One insert per chunk avoids N database round trips for large selections.
    for (let start = 0; start < videos.length; start += 200) {
      const values: unknown[] = [];
      const tuples = videos.slice(start, start + 200).map((video, index) => {
        const base = values.length;
        values.push(
          randomUUID(),
          id,
          start + index,
          JSON.stringify(video),
          Date.now(),
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5})`;
      });
      await client.query(
        `INSERT INTO transcript_batch_items (id, batch_id, position, video, updated_at) VALUES ${tuples.join(",")}`,
        values,
      );
    }
  });
  return id;
}

export async function listBatches(userId: string): Promise<BatchJob[]> {
  return queryRows<BatchJob>(
    `SELECT ${JOB_COLUMNS} FROM transcript_batches b LEFT JOIN transcript_batch_items i ON i.batch_id = b.id
     WHERE b.user_id = $1 AND b.id IN (SELECT id FROM transcript_batches WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30)
     GROUP BY b.id ORDER BY b.created_at DESC`,
    [userId],
  );
}

export async function readBatch(
  userId: string,
  id: string,
  offset = 0,
): Promise<BatchDetail | null> {
  const job = await queryRow<BatchJob>(
    `SELECT ${JOB_COLUMNS} FROM transcript_batches b LEFT JOIN transcript_batch_items i ON i.batch_id = b.id WHERE b.user_id = $1 AND b.id = $2 GROUP BY b.id`,
    [userId, id],
  );
  if (!job) return null;
  const items = await queryRows<BatchItem>(
    `SELECT id, position, video, status,
      CASE WHEN status = 'processing' AND lease_until < $3 THEN '处理中断，等待继续恢复' ELSE stage END AS stage,
      (status = 'processing' AND lease_until < $3) AS interrupted,
      error, history_record_id AS "historyRecordId" FROM transcript_batch_items WHERE batch_id = $1 ORDER BY position LIMIT 50 OFFSET $2`,
    [id, offset, Date.now()],
  );
  return { job, items, total: job.total, offset };
}

export async function controlBatch(
  userId: string,
  id: string,
  action: "pause" | "resume" | "retry" | "cancel",
  itemId?: string,
): Promise<boolean> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT id, status FROM transcript_batches WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [id, userId],
    );
    if (!rows.length) return false;
    if (rows[0].status === "canceled" && action !== "retry") return action === "cancel";
    if (action === "cancel") {
      await client.query(
        "UPDATE transcript_batches SET status = 'canceled' WHERE id = $1",
        [id],
      );
      await client.query(
        "UPDATE transcript_batch_items SET status = 'canceled', stage = '已取消', error = NULL, lease_token = NULL, lease_until = 0, updated_at = $2 WHERE batch_id = $1 AND status IN ('queued', 'processing', 'waiting')",
        [id, Date.now()],
      );
      return true;
    }
    if (action === "retry" || action === "resume") {
      // Preserve provider IDs and completed parts: a retry first resumes any accepted job.
      const retried = await client.query(
        "UPDATE transcript_batch_items SET status = 'queued', generation = generation + 1, retries = 0, next_run_at = 0, error = NULL, stage = '等待重试' WHERE batch_id = $1 AND " +
          (action === "retry" ? "(status IN ('failed', 'canceled') OR (status = 'queued' AND error IS NOT NULL))" : "(status = 'failed' OR (status = 'queued' AND error IS NOT NULL))") +
          (itemId ? " AND id = $2" : ""),
        itemId ? [id, itemId] : [id],
      );
      if (itemId && !retried.rowCount) return false;
    }
    await client.query(
      "UPDATE transcript_batches SET status = $2 WHERE id = $1",
      [id, action === "pause" ? "paused" : "running"],
    );
    await settleBatch(id, client);
    return true;
  });
}

export const LEASE_MS = 120_000;
export async function claimBatchItem(maxInFlight = 8): Promise<ClaimedItem | null> {
  return withTransaction(async (client) => {
    // Serialize only admission so multiple instances cannot exceed the durable pipeline window.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('echolens.batch.admission'))");
    const { rows } = await client.query<ClaimedItem>(
      `SELECT i.*, b.user_id, b.platform, b.model FROM transcript_batch_items i JOIN transcript_batches b ON b.id = i.batch_id
      WHERE (b.status = 'running' OR (b.status = 'paused' AND i.status = 'waiting')) AND i.next_run_at <= $1
      AND (i.status IN ('queued', 'waiting') OR (i.status = 'processing' AND i.lease_until < $1))
      AND (i.status <> 'queued' OR (SELECT COUNT(*) FROM transcript_batch_items WHERE status = 'waiting' OR (status = 'processing' AND lease_until > $1)) < $2)
      ORDER BY CASE WHEN i.status = 'waiting' THEN 0 ELSE 1 END, b.created_at, i.position LIMIT 1 FOR UPDATE OF i SKIP LOCKED`,
      [Date.now(), maxInFlight],
    );
    const item = rows[0];
    if (!item) return null;
    const token = randomUUID();
    await client.query(
      "UPDATE transcript_batch_items SET status = 'processing', lease_token = $2, lease_until = $3, updated_at = $4 WHERE id = $1",
      [item.id, token, Date.now() + LEASE_MS, Date.now()],
    );
    return { ...item, lease_token: token };
  });
}

export async function renewBatchLease(item: ClaimedItem): Promise<boolean> {
  return (
    (await execute(
      "UPDATE transcript_batch_items SET lease_until = $3 WHERE id = $1 AND lease_token = $2 AND status = 'processing'",
      [item.id, item.lease_token, Date.now() + LEASE_MS],
    )) > 0
  );
}

export async function checkpointItem(
  item: ClaimedItem,
  input: {
    stage: string;
    asrJobId?: string;
    historyRecordId?: string;
    completedParts?: CompletedPart[];
    partCount?: number;
  },
): Promise<void> {
  const updated = await execute(
    `UPDATE transcript_batch_items SET stage = $3, asr_job_id = COALESCE($4, asr_job_id), history_record_id = COALESCE($5, history_record_id),
    completed_parts = COALESCE($6::jsonb, completed_parts), part_count = COALESCE($7, part_count), updated_at = $8 WHERE id = $1 AND lease_token = $2 AND status = 'processing'`,
    [
      item.id,
      item.lease_token,
      input.stage,
      input.asrJobId ?? null,
      input.historyRecordId ?? null,
      input.completedParts ? JSON.stringify(input.completedParts) : null,
      input.partCount ?? null,
      Date.now(),
    ],
  );
  if (!updated) throw new LeaseLostError();
}

export class LeaseLostError extends Error {
  constructor() {
    super("批量任务执行租约已失效。");
  }
}

export async function finishItem(
  item: ClaimedItem,
  outcome:
    { text: string } | { pending: true } | { skipped: string } | { error: string; retry: boolean; pause?: boolean; retryAfterMs?: number },
): Promise<void> {
  await withTransaction(async (client) => {
    // Control and completion lock the batch before its items to avoid lock inversion.
    await client.query(
      "SELECT id FROM transcript_batches WHERE id = $1 FOR UPDATE",
      [item.batch_id],
    );
    const success = "text" in outcome;
    const pending = "pending" in outcome;
    const skipped = "skipped" in outcome;
    const paused = "error" in outcome && outcome.pause === true;
    const retries = success || pending || skipped || paused ? item.retries : item.retries + 1;
    const status = success
      ? "succeeded"
      : pending ? "waiting"
      : skipped ? "skipped"
      : paused || ("error" in outcome && outcome.retry)
        ? "queued"
        : "failed";
    const updated = await client.query(
      `UPDATE transcript_batch_items SET status = $3, stage = $4, transcript = $5, error = $6, retries = $7,
      next_run_at = $8, lease_token = NULL, lease_until = 0, updated_at = $9,
      generation = generation + $10 WHERE id = $1 AND lease_token = $2`,
      [
        item.id,
        item.lease_token,
        status,
        success
          ? "转录完成"
          : pending ? "转录中"
          : skipped ? "已跳过"
          : paused
            ? "等待继续"
            : status === "queued"
              ? "等待自动重试"
              : "转录失败",
        success ? outcome.text : null,
        skipped ? outcome.skipped : "error" in outcome ? outcome.error : null,
        retries,
        paused || success || skipped ? 0 : Date.now() + (pending ? 3000 : Math.max("error" in outcome ? outcome.retryAfterMs ?? 0 : 0, exponentialRetryDelay(retries, 3000, 300_000))),
        Date.now(),
        !success && !pending && !paused && status === "queued" ? 1 : 0,
      ],
    );
    if (!updated.rowCount) return;
    if (paused)
      await client.query(
        "UPDATE transcript_batches SET status = 'paused' WHERE id = $1",
        [item.batch_id],
      );
    await settleBatch(item.batch_id, client);
  });
}

async function settleBatch(
  id: string,
  client: import("@/lib/storage/postgres").DbExecutor,
): Promise<void> {
  await client.query(
    `UPDATE transcript_batches SET status = 'completed' WHERE id = $1 AND status = 'running'
    AND NOT EXISTS (SELECT 1 FROM transcript_batch_items WHERE batch_id = $1 AND status IN ('queued', 'processing', 'waiting'))`,
    [id],
  );
}

export async function recoverBatchQueue(): Promise<void> {
  await withTransaction(async client => {
    // Revisit legacy ASR pauses through their persisted failure codes, without resubmitting them.
    await client.query(
      `UPDATE transcript_batches b SET status = 'running' WHERE b.status = 'paused'
       AND EXISTS (SELECT 1 FROM transcript_batch_items i JOIN transcript_asr_tasks a ON a.id = i.asr_job_id
         WHERE i.batch_id = b.id AND i.status = 'queued' AND i.error IS NOT NULL AND a.status = 'failed'
         AND a.result->>'code' <> 'not_configured'
         AND (a.result->>'code' IN ('no_speech', 'unavailable') OR a.result->>'submissionUncertain' = 'true'
           OR a.result->>'retryable' = 'false'))`,
    );
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM transcript_batches b WHERE status IN ('running', 'completed')
       AND EXISTS (SELECT 1 FROM transcript_batch_items WHERE batch_id = b.id AND status = 'failed') FOR UPDATE`,
    );
    if (!rows.length) return;
    const ids = rows.map(row => row.id);
    await client.query("UPDATE transcript_batches SET status = 'running' WHERE id = ANY($1::text[])", [ids]);
    await client.query(
      `UPDATE transcript_batch_items SET status = 'queued', generation = generation + 1,
       next_run_at = 0, stage = '等待自动重试' WHERE batch_id = ANY($1::text[]) AND status = 'failed'`, [ids],
    );
  });
}

export async function* readBatchExport(
  userId: string,
  id: string,
  options: { asOf?: number; position?: number; after?: number; limit?: number } = {},
): AsyncGenerator<BatchExportRow> {
  const asOf = options.asOf ?? Date.now();
  let position = options.after ?? -1;
  let remaining = options.limit ?? Infinity;
  while (remaining > 0) {
    const rows = await queryRows<BatchExportRow>(
      `SELECT i.position, i.video, i.transcript FROM transcript_batch_items i JOIN transcript_batches b ON b.id = i.batch_id
      WHERE b.user_id = $1 AND b.id = $2 AND i.status = 'succeeded' AND i.position > $3 AND i.updated_at <= $4
      AND ($5::integer IS NULL OR i.position = $5) ORDER BY i.position LIMIT $6`,
      [userId, id, position, asOf, options.position ?? null, Math.min(50, remaining)],
    );
    if (!rows.length) return;
    for (const row of rows) {
      position = row.position;
      yield row;
    }
    remaining -= rows.length;
  }
}
