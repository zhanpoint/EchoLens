export const BATCH_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS transcript_batches (
    id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform text NOT NULL CHECK (platform IN ('douyin', 'bilibili')),
    author_name text NOT NULL, model text NOT NULL, status text NOT NULL DEFAULT 'running',
    created_at bigint NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS transcript_batches_user_idx ON transcript_batches(user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS transcript_batch_items (
    id text PRIMARY KEY, batch_id text NOT NULL REFERENCES transcript_batches(id) ON DELETE CASCADE,
    position integer NOT NULL, video jsonb NOT NULL, status text NOT NULL DEFAULT 'queued',
    stage text NOT NULL DEFAULT '等待转录', error text, history_record_id text,
    asr_job_id text, generation integer NOT NULL DEFAULT 0, retries integer NOT NULL DEFAULT 0,
    next_run_at bigint NOT NULL DEFAULT 0, lease_token text, lease_until bigint NOT NULL DEFAULT 0,
    transcript text, completed_parts jsonb NOT NULL DEFAULT '[]'::jsonb, updated_at bigint NOT NULL, UNIQUE(batch_id, position)
  )`,
  `CREATE INDEX IF NOT EXISTS transcript_batch_items_queue_idx ON transcript_batch_items(status, next_run_at, lease_until)`,
  `CREATE INDEX IF NOT EXISTS transcript_batch_items_batch_idx ON transcript_batch_items(batch_id, position)`,
  `ALTER TABLE transcript_batch_items ADD COLUMN IF NOT EXISTS part_count integer NOT NULL DEFAULT 0`,
  `ALTER TABLE transcript_asr_tasks ADD COLUMN IF NOT EXISTS result jsonb`,
];
