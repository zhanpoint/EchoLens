import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ensurePostgresSchema,
  setPostgresPoolForTest,
  closePostgresPoolForTest,
  execute,
  queryRow,
} from "@/lib/storage/postgres";
import { insertUser } from "@/lib/auth/db";
import {
  createBatch,
  readBatch,
  listBatches,
  controlBatch,
  claimBatchItem,
  finishItem,
  checkpointItem,
  renewBatchLease,
  LeaseLostError,
  readBatchExport,
} from "@/lib/batch/db";
import {
  insertAsrTask,
  markAsrTaskSucceeded,
  checkpointAsrTaskResult,
  markAsrTaskCanceled,
  readAsrTask,
} from "@/lib/transcript/db";

// Real PostgreSQL is necessary to validate SKIP LOCKED, transaction races, and fencing.
// This opt-in suite creates and drops its own database, never production tables.
describe.runIf(process.env.BATCH_POSTGRES_TEST === "1")(
  "durable batches on real PostgreSQL",
  () => {
    const database = `echolens_batch_test_${randomUUID().replaceAll("-", "")}`;
    let admin: Pool;
    let pool: Pool;
    beforeAll(async () => {
      process.loadEnvFile(".env");
      const config = {
        host: process.env.POSTGRES_HOST || "localhost",
        port: Number(process.env.POSTGRES_PORT || 5432),
        user: process.env.POSTGRES_USER || "postgres",
        password: process.env.POSTGRES_PASSWORD,
      };
      admin = new Pool({ ...config, database: "postgres" });
      await admin.query(`CREATE DATABASE "${database}"`);
      pool = new Pool({ ...config, database });
      setPostgresPoolForTest(pool);
      await ensurePostgresSchema();
      for (const id of ["owner", "other"])
        await insertUser({
          id,
          email: `${id}@example.com`,
          username: id,
          passwordHash: "hash",
          termsAcceptedAt: Date.now(),
        });
    }, 30_000);
    afterAll(async () => {
      await closePostgresPoolForTest();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await admin.end();
      }
    });
    beforeEach(async () => {
      await execute("DELETE FROM transcript_batches");
    });
    const input = {
      platform: "douyin" as const,
      authorName: "作者",
      model: "e1" as const,
      videos: [
        {
          id: "123456",
          title: "视频",
          coverUrl: "",
          durationSeconds: 60,
          publishedAt: 0,
        },
      ],
    };

    it("deduplicates selection and denies another user's reads, control, and export", async () => {
      const id = await createBatch("owner", {
        ...input,
        videos: [...input.videos, ...input.videos],
      });
      expect((await readBatch("owner", id))?.job.total).toBe(1);
      expect(await readBatch("other", id)).toBeNull();
      expect(await controlBatch("other", id, "pause")).toBe(false);
      expect(await listBatches("other")).toEqual([]);
      const exported = [];
      for await (const row of readBatchExport("other", id)) exported.push(row);
      expect(exported).toEqual([]);
    });
    it("allows one concurrent claim and only reclaims it after lease expiry", async () => {
      await createBatch("owner", input);
      const claims = await Promise.all(
        Array.from({ length: 8 }, () => claimBatchItem()),
      );
      const first = claims.find((item) => item)!;
      expect(claims.filter(Boolean)).toHaveLength(1);
      await execute(
        "UPDATE transcript_batch_items SET lease_until = 0 WHERE id = $1",
        [first.id],
      );
      const resumed = (await claimBatchItem())!;
      expect(resumed.id).toBe(first.id);
      expect(resumed.lease_token).not.toBe(first.lease_token);
      expect(await renewBatchLease(first)).toBe(false);
      await expect(
        checkpointItem(first, { stage: "stale" }),
      ).rejects.toBeInstanceOf(LeaseLostError);
      await finishItem(first, { text: "stale result" });
      expect((await readBatch("owner", first.batch_id))?.items[0].status).toBe(
        "processing",
      );
      await finishItem(resumed, { text: "resumed result" });
      expect((await readBatch("owner", first.batch_id))?.job.status).toBe(
        "completed",
      );
    });
    it("exports only the requested completed position and keeps owner isolation", async () => {
      const id = await createBatch("owner", { ...input, videos: [input.videos[0], { ...input.videos[0], id: "123457", tags: ["摄影"] }] });
      await finishItem((await claimBatchItem())!, { text: "第一个" });
      await finishItem((await claimBatchItem())!, { text: "第二个" });
      const rows = [];
      for await (const row of readBatchExport("owner", id, { position: 1 })) rows.push(row);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ position: 1, video: { id: "123457", tags: ["摄影"] }, transcript: "第二个" });
      const forbidden = [];
      for await (const row of readBatchExport("other", id, { position: 1 })) forbidden.push(row);
      expect(forbidden).toEqual([]);
      const page = [];
      for await (const row of readBatchExport("owner", id, { after: 0, limit: 1 })) page.push(row);
      expect(page.map(({ position }) => position)).toEqual([1]);
    });
    it("pauses dispatch, resumes queued work, and retries only failed items", async () => {
      const id = await createBatch("owner", input);
      await controlBatch("owner", id, "pause");
      expect(await claimBatchItem()).toBeNull();
      await controlBatch("owner", id, "resume");
      const item = (await claimBatchItem())!;
      await finishItem(item, { error: "failed", retry: false });
      await controlBatch("owner", id, "retry");
      const retry = (await claimBatchItem())!;
      expect(retry.generation).toBe(1);
      await finishItem(retry, { text: "成功" });
      await controlBatch("owner", id, "retry");
      expect(await claimBatchItem()).toBeNull();
    });
    it("retries a selected failure and preserves other failures, successful results and checkpoints", async () => {
      const id = await createBatch("owner", { ...input, videos: [input.videos[0], { ...input.videos[0], id: "123457" }, { ...input.videos[0], id: "123458" }] });
      const completed = (await claimBatchItem())!;
      await finishItem(completed, { text: "已完成" });
      const first = (await claimBatchItem())!;
      await checkpointItem(first, { stage: "转录中", asrJobId: "accepted-asr", partCount: 2, completedParts: [{ workId: "part-1", title: "P1", text: "保留的文字" }] });
      await finishItem(first, { error: "后处理失败", retry: false });
      const second = (await claimBatchItem())!;
      await finishItem(second, { error: "其他失败", retry: false });
      expect(await controlBatch("owner", id, "retry", first.id)).toBe(true);
      const retried = (await claimBatchItem())!;
      expect(retried).toMatchObject({ id: first.id, generation: 1, retries: 0, asr_job_id: "accepted-asr", part_count: 2, completed_parts: [{ workId: "part-1", title: "P1", text: "保留的文字" }] });
      expect(await claimBatchItem()).toBeNull();
      expect((await readBatch("owner", id))!.items.map(item => item.status)).toEqual(["succeeded", "processing", "failed"]);
    });

    it("rejects retry targets outside the batch or owner and does not resume a paused batch", async () => {
      const id = await createBatch("owner", input);
      const item = (await claimBatchItem())!;
      await finishItem(item, { error: "failed", retry: false });
      await controlBatch("owner", id, "pause");
      expect(await controlBatch("other", id, "retry", item.id)).toBe(false);
      expect(await controlBatch("owner", id, "retry", randomUUID())).toBe(false);
      expect((await readBatch("owner", id))!.job).toMatchObject({ status: "paused", failed: 1 });
      expect(await claimBatchItem()).toBeNull();
    });

    it("cancels unfinished items, fences active workers, and preserves completed exports", async () => {
      const id = await createBatch("owner", {
        ...input,
        videos: [
          input.videos[0],
          { ...input.videos[0], id: "123457" },
          { ...input.videos[0], id: "123458" },
        ],
      });
      const completed = (await claimBatchItem())!;
      await finishItem(completed, { text: "已完成结果" });
      const active = (await claimBatchItem())!;
      await checkpointItem(active, {
        stage: "转录中",
        asrJobId: "accepted-task",
      });
      expect(await controlBatch("other", id, "cancel")).toBe(false);
      await controlBatch("owner", id, "cancel");
      expect(await renewBatchLease(active)).toBe(false);
      await expect(
        checkpointItem(active, { stage: "旧执行器" }),
      ).rejects.toBeInstanceOf(LeaseLostError);
      await finishItem(active, { text: "迟到的结果" });
      expect(await controlBatch("owner", id, "resume")).toBe(false);
      expect(await claimBatchItem()).toBeNull();
      const batch = (await readBatch("owner", id))!;
      expect(batch.job).toMatchObject({
        status: "canceled",
        succeeded: 1,
        canceled: 2,
        processing: 0,
      });
      expect(batch.items.map((item) => item.status)).toEqual([
        "succeeded",
        "canceled",
        "canceled",
      ]);
      const exported = [];
      for await (const row of readBatchExport("owner", id)) exported.push(row);
      expect(exported).toHaveLength(1);
      expect(exported[0].transcript).toBe("已完成结果");
    });
    it("reports expired execution as interrupted until it is reclaimed", async () => {
      const id = await createBatch("owner", input);
      const item = (await claimBatchItem())!;
      await checkpointItem(item, { stage: "转录中" });
      await execute(
        "UPDATE transcript_batch_items SET lease_until = 0 WHERE id = $1",
        [item.id],
      );
      expect((await readBatch("owner", id))?.items[0].stage).toBe(
        "处理中断，等待继续恢复",
      );
      expect((await readBatch("owner", id))?.job).toMatchObject({
        processing: 0,
        interrupted: 1,
      });
      expect((await readBatch("owner", id))?.items[0].interrupted).toBe(true);
    });
    it("persists provider and per-part checkpoints across reclaimed executions", async () => {
      const id = await createBatch("owner", input);
      const item = (await claimBatchItem())!;
      await checkpointItem(item, {
        stage: "转录中",
        asrJobId: "asr-1",
        completedParts: [{ workId: "123456", title: "视频", text: "结果" }],
      });
      await execute(
        "UPDATE transcript_batch_items SET lease_until = 0 WHERE id = $1",
        [item.id],
      );
      const resumed = (await claimBatchItem())!;
      expect(resumed.asr_job_id).toBe("asr-1");
      expect(resumed.completed_parts[0].text).toBe("结果");
      await finishItem(resumed, { text: "结果" });
      const exported = [];
      for await (const row of readBatchExport("owner", id)) exported.push(row);
      expect(exported[0].transcript).toBe("结果");
    });
    it("stores successful ASR output atomically with its terminal status", async () => {
      await insertAsrTask({
        id: "asr-result",
        userId: "owner",
        cacheKey: "cache",
        workKey: "video:123456",
        model: "qwen-audio-3.1-asr-flash-filetrans",
        objectKey: "audio",
        taskId: "provider-task",
        audioDurationSeconds: 60,
      });
      await markAsrTaskSucceeded("asr-result", {
        ok: true,
        content: "持久化结果",
      });
      expect(
        await readAsrTask({ id: "asr-result", userId: "owner" }),
      ).toMatchObject({
        status: "succeeded",
        result: { content: "持久化结果" },
      });
      expect(
        await queryRow(
          "SELECT transcript FROM transcript_batch_items WHERE id = 'missing'",
        ),
      ).toBeUndefined();
    });
    it("retries a paused batch with queued work even when no item has failed", async () => {
      const id = await createBatch("owner", input);
      const item = (await claimBatchItem())!;
      await checkpointItem(item, { stage: "识别中", asrJobId: "accepted-task", partCount: 1 });
      await finishItem(item, { error: "访问暂时受限", retry: false, pause: true });
      expect((await readBatch("owner", id))!.job).toMatchObject({ status: "paused", failed: 0 });
      expect(await controlBatch("owner", id, "retry")).toBe(true);
      const resumed = (await claimBatchItem())!;
      expect(resumed).toMatchObject({ id: item.id, generation: 0, retries: 0, asr_job_id: "accepted-task", part_count: 1 });
    });

    it("retries canceled and failed items without discarding results or accepting stale workers", async () => {
      const id = await createBatch("owner", { ...input, videos: Array.from({ length: 4 }, (_, index) => ({ ...input.videos[0], id: String(123456 + index) })) });
      const completed = (await claimBatchItem())!;
      await finishItem(completed, { text: "已保存结果" });
      const failed = (await claimBatchItem())!;
      await finishItem(failed, { error: "转录失败", retry: false });
      const active = (await claimBatchItem())!;
      await checkpointItem(active, { stage: "识别中", asrJobId: "accepted-asr", partCount: 2, completedParts: [{ workId: "part-1", title: "P1", text: "已保存分 P" }] });
      await controlBatch("owner", id, "cancel");
      expect(await controlBatch("other", id, "retry")).toBe(false);
      expect(await controlBatch("owner", id, "retry")).toBe(true);
      const batch = (await readBatch("owner", id))!;
      expect(batch.job).toMatchObject({ status: "running", succeeded: 1, failed: 0, canceled: 0 });
      expect(batch.items.map(item => item.status)).toEqual(["succeeded", "queued", "queued", "queued"]);
      expect((await claimBatchItem())!).toMatchObject({ id: failed.id, generation: 1, retries: 0 });
      const resumed = (await claimBatchItem())!;
      expect(resumed).toMatchObject({ id: active.id, generation: 1, asr_job_id: "accepted-asr", part_count: 2, completed_parts: [{ workId: "part-1", title: "P1", text: "已保存分 P" }] });
      expect(await renewBatchLease(active)).toBe(false);
      await expect(checkpointItem(active, { stage: "旧执行器" })).rejects.toBeInstanceOf(LeaseLostError);
      const exported = [];
      for await (const row of readBatchExport("owner", id)) exported.push(row.transcript);
      expect(exported).toEqual(["已保存结果"]);
    });

    it("keeps active leases and queued work intact when retrying a running batch", async () => {
      const id = await createBatch("owner", { ...input, videos: Array.from({ length: 3 }, (_, index) => ({ ...input.videos[0], id: String(123456 + index) })) });
      const failed = (await claimBatchItem())!;
      await finishItem(failed, { error: "失败", retry: false });
      const active = (await claimBatchItem())!;
      await checkpointItem(active, { stage: "识别中", asrJobId: "active-asr" });
      expect(await controlBatch("owner", id, "retry")).toBe(true);
      expect(await renewBatchLease(active)).toBe(true);
      await checkpointItem(active, { stage: "仍在处理" });
      expect((await claimBatchItem())!).toMatchObject({ id: failed.id, generation: 1 });
      expect((await claimBatchItem())!).toMatchObject({ position: 2, generation: 0 });
      expect(await claimBatchItem()).toBeNull();
    });

    it("persists synchronous recognition while running and rejects checkpoints after cancellation", async () => {
      await insertAsrTask({ id: "flash-checkpoint", userId: "owner", cacheKey: "flash-cache", workKey: "video:123456",
        model: "qwen-audio-3.1-asr-flash", objectKey: "audio.m4a", taskId: "pending:flash-checkpoint", audioDurationSeconds: 30 });
      expect(await checkpointAsrTaskResult("flash-checkpoint", { ok: true, content: "已识别" })).toBe(true);
      expect(await readAsrTask({ id: "flash-checkpoint", userId: "owner" })).toMatchObject({ status: "running", result: { content: "已识别" } });
      await markAsrTaskCanceled("flash-checkpoint");
      expect(await checkpointAsrTaskResult("flash-checkpoint", { ok: true, content: "过期写入" })).toBe(false);
      expect(await readAsrTask({ id: "flash-checkpoint", userId: "owner" })).toMatchObject({ status: "canceled", result: { content: "已识别" } });
    });
    it("migrates old model selections once and preserves translation overrides", async () => {
      const id = await createBatch("owner", input);
      await execute("UPDATE transcript_batches SET model = 'e2' WHERE id = $1", [id]);
      await execute("INSERT INTO user_settings (user_id, category, value, updated_at) VALUES ('owner', 'aiModels', $1::jsonb, 1)", [JSON.stringify({ asrE1: "old-asr", asrE2: "old-e2", asrE3: "old-e3", translation: "qwen-mt-plus", summary: "old-summary" })]);
      await execute("DELETE FROM app_schema_migrations WHERE version = 'transcript-schema-v7-qwen-audio-31'");
      setPostgresPoolForTest(pool);
      await ensurePostgresSchema();
      expect((await readBatch("owner", id))!.job.model).toBe("e1");
      expect(await queryRow("SELECT value FROM user_settings WHERE user_id = 'owner' AND category = 'aiModels'")).toEqual({ value: {
        asrE1: "qwen-audio-3.1-asr-flash-filetrans", translation: "qwen-mt-plus", transcriptPostprocess: "deepseek-v4.1-flash", summary: "deepseek-v4.1-flash",
      } });
      await execute("UPDATE user_settings SET value = value || '{\"summary\":\"qwen3.7-plus\"}'::jsonb WHERE user_id = 'owner' AND category = 'aiModels'");
      setPostgresPoolForTest(pool);
      await ensurePostgresSchema();
      expect(await queryRow("SELECT value->>'summary' AS summary FROM user_settings WHERE user_id = 'owner' AND category = 'aiModels'")).toEqual({ summary: "qwen3.7-plus" });
    });
    it("preserves paused work and resumes the same checkpoints without consuming retries", async () => {
      const id = await createBatch("owner", input);
      const item = (await claimBatchItem())!;
      await checkpointItem(item, { stage: "准备中", asrJobId: "accepted-task", partCount: 1 });
      await finishItem(item, { error: "平台暂时限制访问", retry: false, pause: true });
      const paused = (await readBatch("owner", id))!;
      expect(paused.job.status).toBe("paused");
      expect(paused.items[0]).toMatchObject({ status: "queued", stage: "等待继续", error: "平台暂时限制访问" });
      expect(await claimBatchItem()).toBeNull();
      await controlBatch("owner", id, "resume");
      const resumed = (await claimBatchItem())!;
      expect(resumed).toMatchObject({ id: item.id, asr_job_id: "accepted-task", retries: 0, generation: 0, part_count: 1 });
    });
  },
);
