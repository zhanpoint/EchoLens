import { randomUUID } from "node:crypto";
import {
  getBilibiliDashSelection,
  resolveBilibiliWork,
  buildBilibiliWorkId,
} from "@/lib/bilibili/client";
import { readUsableBilibiliCookie } from "@/lib/bilibili/account";
import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";
import { readDouyinCredentialState } from "@/lib/douyin/account";
import { readUserSetting } from "@/lib/user-settings";
import { readDashScopeUserConfig } from "@/lib/dashscope/user-credential";
import {
  refreshDashScopeAsrJobWithOptions,
  submitDashScopeAsrJob,
  type DashScopeAsrJobResult,
} from "@/lib/dashscope/asr";
import {
  readAsrTask,
  findOrCreateTranscriptHistoryRecord,
  updateTranscriptHistoryRecordTranscript,
  markAsrTaskFailed,
  type StoredAsrTask,
} from "@/lib/transcript/db";
import {
  prepareBilibiliSnapshotAsset,
  prepareDouyinSnapshotAsset,
  ensureHistoryAsset,
  type AvailableHistoryAsset,
} from "@/lib/transcript/assets";
import {
  createBilibiliResourceSnapshot,
  createDouyinResourceSnapshot,
} from "@/lib/media/resource-snapshot";
import { openApiPlatformRequestPolicy } from "@/lib/open-api/platform-request-policy";
import type { ProviderResult } from "@/lib/ai/provider-result";
import { AudioUnavailableError } from "@/lib/media/audio";
import { FfmpegProcessError } from "@/lib/media/ffmpeg-runner";
import { checkpointItem, type ClaimedItem } from "./db";
import { videoUrl } from "./contracts";

export class BatchBlockedError extends Error {}
type BatchItemResult = string | { pending: true } | { skipped: string };
export async function transcribeBatchItem(
  item: ClaimedItem,
  signal: AbortSignal,
): Promise<BatchItemResult> {
  signal.throwIfAborted();
  if (item.part_count > 0 && item.completed_parts.length === item.part_count)
    return mergeParts(item.completed_parts);
  const config = await readDashScopeUserConfig(item.user_id);
  const completed = [...item.completed_parts];
  const previous = item.asr_job_id
    ? await readAsrTask({ id: item.asr_job_id, userId: item.user_id })
    : null;
  const context = previous?.historyContext;
  if (context && (previous.status === "running" || previous.status === "succeeded" ||
    (previous.failure && shouldSkipFailure(previous.failure))) &&
    !completed.some(part => part.workId === context.work.id)) {
    const result = await resume(previous);
    if (result?.status === "running") return { pending: true };
    await savePart(context.work.id, context.work.caption, context.historyRecordId, result);
    if (item.part_count > 0 && completed.length === item.part_count) return mergeParts(completed);
  }
  const cookie = item.platform === "bilibili"
    ? readUsableBilibiliCookie(await readUserSetting(item.user_id, "bilibili"))
    : "";
  const url = videoUrl(item.platform, item.video.id);
  const resolved =
    item.platform === "bilibili"
      ? await resolveBilibiliWork(url, cookie, {
          requestPolicy: openApiPlatformRequestPolicy.forUser(item.user_id),
        })
      : null;
  const parts = resolved
    ? resolved.metadata.pages
    : [
        {
          cid: 0,
          durationSeconds: item.video.durationSeconds,
          page: 1,
          part: item.video.title,
        },
      ];
  await checkpointItem(item, {
    stage: "读取作品信息",
    partCount: parts.length,
  });

  for (const part of parts) {
    signal.throwIfAborted();
    const workId = resolved
      ? buildBilibiliWorkId(resolved.metadata.bvid, part.cid)
      : item.video.id;
    if (completed.some((entry) => entry.workId === workId)) continue;
    const title =
      parts.length > 1
        ? `${item.video.title} · P${part.page} ${part.part}`
        : item.video.title;
    const finalUrl = resolved ? `${url}?p=${part.page}` : url;
    const workKey = resolved ? `bilibili:video:${workId}` : `video:${workId}`;
    const { record: history } = await findOrCreateTranscriptHistoryRecord({
      id: randomUUID(),
      userId: item.user_id,
      workId,
      workKey,
      workKind: "video",
      caption: title,
      finalUrl,
      inputUrl: finalUrl,
      durationSeconds: part.durationSeconds,
      transcriptContent: "",
      authorName: resolved?.metadata.authorName,
    });
    await checkpointItem(item, {
      stage: `准备音频${parts.length > 1 ? ` · P${part.page}/${parts.length}` : ""}`,
      historyRecordId: history.id,
    });

    // The deterministic ID closes the gap between an accepted provider job and batch checkpoints.
    const reusable =
      previous?.workKey === workKey &&
      (previous.status === "running" || previous.status === "succeeded" ||
        (previous.failure && shouldSkipFailure(previous.failure)));
    const jobId = reusable
      ? previous.id
      : `${item.id}:${item.generation}:${part.cid}`;
    const stored = reusable
      ? previous
      : await readAsrTask({ id: jobId, userId: item.user_id });
    if (
      stored?.status !== "succeeded" &&
      !config.customApiKey &&
      !config.platformApiKey
    )
      throw new BatchBlockedError(
        "转录服务未配置，请先在设置中配置 API Key 后重试。",
      );
    let result: DashScopeAsrJobResult | null;
    if (stored) {
      result = await resume(stored);
    } else {
      let audio: AvailableHistoryAsset;
      try {
        audio = await prepareAudio();
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof FfmpegProcessError || error instanceof AudioUnavailableError)) throw error;
        await skipPart(workId, title, error.message);
        continue;
      }
      signal.throwIfAborted();
      const custom = Boolean(config.customApiKey);
      const models = custom ? config.customModels : config.platformModels;
      await checkpointItem(item, { stage: "提交转录", asrJobId: jobId });
      item.asr_job_id = jobId;
      result = await submitDashScopeAsrJob(
        item.user_id,
        workKey,
        {
          objectKey: audio.objectKey!,
          signedUrl: audio.url,
          durationSeconds: audio.durationSeconds,
        },
        {
          // Batch work needs a queryable provider task even for short audio.
          model: models.asrE1,
        },
        {
          apiKey: custom ? config.customApiKey : config.platformApiKey,
          credentialSource: custom ? "custom" : "platform",
          clientJobId: jobId,
          historyContext: {
            historyRecordId: history.id,
            work: {
              id: workId,
              kind: "video",
              inputUrl: finalUrl,
              finalUrl,
              caption: title,
              durationSeconds: audio.durationSeconds,
              ...(resolved ? { source: "bilibili" as const } : {}),
            },
          },
          signal,
          title,
        },
      );
    }
    if (result?.status === "running") {
      await checkpointItem(item, { stage: "转录中", asrJobId: jobId });
      return { pending: true };
    }
    await savePart(workId, title, history.id, result);

    async function prepareAudio(): Promise<AvailableHistoryAsset> {
      if (history.originalAudio) {
        const cached = await ensureHistoryAsset({
          assetKind: "originalAudio", historyRecordId: history.id, userId: item.user_id, signal,
        });
        if (cached) return cached;
      }
      if (resolved) {
        const metadata = {
          ...resolved.metadata,
          cid: part.cid,
          page: part.page,
          durationSeconds: part.durationSeconds,
          caption: title,
        };
        const selection = await getBilibiliDashSelection({
          bvid: metadata.bvid,
          cid: metadata.cid,
          cookie,
          requestPolicy: openApiPlatformRequestPolicy.forUser(item.user_id),
        });
        const asset = await prepareBilibiliSnapshotAsset({
          assetKind: "originalAudio",
          historyRecordId: history.id,
          userId: item.user_id,
          workId,
          workKey,
          metadata,
          selection,
          snapshot: createBilibiliResourceSnapshot(metadata, selection),
        });
        if (!asset) throw new AudioUnavailableError("原声音频不可用。");
        return asset;
      }
      const credential = await readDouyinCredentialState(item.user_id);
      if (credential.status !== "valid") {
        throw new BatchBlockedError("请先在设置中更新并验证抖音访问凭证，再继续采集。");
      }
      const lease = await acquireWorkMetadata(
        { id: workId, kind: "video", finalUrl },
        "lowest",
        undefined,
        credential.cookie,
        signal,
      );
      try {
        const asset = await prepareDouyinSnapshotAsset({
          assetKind: "originalAudio",
          historyRecordId: history.id,
          userId: item.user_id,
          workId,
          workKey,
          videoQuality: "lowest",
          metadata: lease.metadata,
          snapshot: createDouyinResourceSnapshot(lease.metadata, "lowest"),
        });
        if (!asset) throw new AudioUnavailableError("原声音频不可用。");
        return asset;
      } finally {
        lease.release();
      }
    }
  }
  return mergeParts(completed);

  async function resume(stored: StoredAsrTask) {
    if (stored.status === "running" && (!stored.taskId || stored.taskId.startsWith("pending:")) && !stored.result) {
      const detail = "上次提交确认中断。重试可能重新计费，请先核对服务商任务记录。";
      const failure = { ok: false as const, code: "error" as const, detail, submissionUncertain: true };
      await markAsrTaskFailed(stored.id, detail, failure);
      return { status: "failed" as const, result: failure };
    }
    return refreshDashScopeAsrJobWithOptions(item.user_id, stored.id, {
      apiKeys: { custom: config.customApiKey, platform: config.platformApiKey },
      postprocessModels: { custom: config.customModels.transcriptPostprocess, platform: config.platformModels.transcriptPostprocess },
      signal,
    });
  }

  async function savePart(workId: string, title: string, historyId: string, result: DashScopeAsrJobResult | null) {
    if (!result || result.status === "running") throw new Error("转录任务不可用。");
    if (result.status !== "successed" || !result.result.ok) {
      const failure = result.result;
      const detail = failure.ok ? "转录任务不可用。" : failure.detail;
      if (!failure.ok && failure.code === "not_configured") throw new BatchBlockedError(detail);
      if (!failure.ok && shouldSkipFailure(failure)) {
        await skipPart(workId, title, detail);
        return;
      }
      throw new Error(detail);
    }
    await updateTranscriptHistoryRecordTranscript({
      id: historyId, userId: item.user_id,
      transcriptContent: result.result.content, transcriptSegments: result.result.transcriptSegments,
    });
    completed.push({ workId, title, text: result.result.content });
    await checkpointItem(item, { stage: "保存转录结果", completedParts: completed });
  }

  async function skipPart(workId: string, title: string, reason: string) {
    completed.push({ workId, title, text: "", skipped: reason });
    await checkpointItem(item, { stage: "跳过不可转录音频", completedParts: completed });
  }
}

function shouldSkipFailure(failure: Extract<ProviderResult, { ok: false }>): boolean {
  return failure.code !== "not_configured" && (failure.code === "no_speech" || failure.code === "unavailable" ||
    failure.submissionUncertain === true || failure.retryable === false);
}

function mergeParts(parts: ClaimedItem["completed_parts"]): BatchItemResult {
  const transcribed = parts.filter(part => !part.skipped && part.text.trim());
  if (!transcribed.length) return { skipped: parts.find(part => part.skipped)?.skipped ?? "未检测到可识别的语音。" };
  return transcribed
    .map((part) =>
      parts.length > 1 ? `# ${part.title}\n\n${part.text}` : part.text,
    )
    .join("\n\n");
}
