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
  getDashScopeAsrModel,
  refreshDashScopeAsrJobWithOptions,
  submitDashScopeAsrJob,
  type DashScopeAsrJobResult,
} from "@/lib/dashscope/asr";
import {
  readAsrTask,
  findOrCreateTranscriptHistoryRecord,
  updateTranscriptHistoryRecordTranscript,
  markAsrTaskFailed,
} from "@/lib/transcript/db";
import {
  prepareBilibiliSnapshotAsset,
  prepareDouyinSnapshotAsset,
  type AvailableHistoryAsset,
} from "@/lib/transcript/assets";
import {
  createBilibiliResourceSnapshot,
  createDouyinResourceSnapshot,
} from "@/lib/media/resource-snapshot";
import { openApiPlatformRequestPolicy } from "@/lib/open-api/platform-request-policy";
import { checkpointItem, type ClaimedItem } from "./db";
import { videoUrl } from "./contracts";

export class RetryableBatchError extends Error {}
export class BatchBlockedError extends Error {}
export async function transcribeBatchItem(
  item: ClaimedItem,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (item.part_count > 0 && item.completed_parts.length === item.part_count)
    return mergeParts(item.completed_parts);
  const config = await readDashScopeUserConfig(item.user_id);
  const settings = await readUserSetting(item.user_id, "bilibili");
  const cookie = readUsableBilibiliCookie(settings);
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
  const completed = [...item.completed_parts];
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
    const previous = item.asr_job_id
      ? await readAsrTask({ id: item.asr_job_id, userId: item.user_id })
      : null;
    const reusable =
      previous?.workKey === workKey &&
      (previous.status === "running" || previous.status === "succeeded");
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
      if (stored.status === "running" && (!stored.taskId || stored.taskId.startsWith("pending:")) && !stored.result) {
        const error =
          "上次提交确认中断。重试可能重新计费，请先核对服务商任务记录。";
        await markAsrTaskFailed(jobId, error);
        throw new Error(error);
      }
      result = await refreshDashScopeAsrJobWithOptions(item.user_id, jobId, {
        apiKeys: {
          custom: config.customApiKey,
          platform: config.platformApiKey,
        },
        postprocessModels: {
          custom: config.customModels.transcriptPostprocess,
          platform: config.platformModels.transcriptPostprocess,
        },
        signal,
      });
    } else {
      const audio = await prepareAudio();
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
          model: getDashScopeAsrModel(audio.durationSeconds, models),
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
    while (result?.status === "running") {
      await checkpointItem(item, { stage: "转录中", asrJobId: jobId });
      await waitForPoll(signal);
      result = await refreshDashScopeAsrJobWithOptions(item.user_id, jobId, {
        apiKeys: {
          custom: config.customApiKey,
          platform: config.platformApiKey,
        },
        postprocessModels: {
          custom: config.customModels.transcriptPostprocess,
          platform: config.platformModels.transcriptPostprocess,
        },
        signal,
      });
    }
    if (!result || result.status !== "successed" || !result.result.ok) {
      const error =
        result && !result.result.ok ? result.result.detail : "转录任务不可用。";
      const task = await readAsrTask({ id: jobId, userId: item.user_id });
      if (
        result &&
        !result.result.ok &&
        result.result.code === "not_configured"
      )
        throw new BatchBlockedError(error);
      if (task?.status === "running") throw new RetryableBatchError(error);
      throw new Error(error);
    }
    await updateTranscriptHistoryRecordTranscript({
      id: history.id,
      userId: item.user_id,
      transcriptContent: result.result.content,
      transcriptSegments: result.result.transcriptSegments,
    });
    completed.push({ workId, title, text: result.result.content });
    await checkpointItem(item, {
      stage: "保存转录结果",
      completedParts: completed,
    });

    async function prepareAudio(): Promise<AvailableHistoryAsset> {
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
        if (!asset) throw new Error("原声音频不可用。");
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
        if (!asset) throw new Error("原声音频不可用。");
        return asset;
      } finally {
        lease.release();
      }
    }
  }
  return mergeParts(completed);
}

function mergeParts(parts: ClaimedItem["completed_parts"]): string {
  return parts
    .map((part) =>
      parts.length > 1 ? `# ${part.title}\n\n${part.text}` : part.text,
    )
    .join("\n\n");
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, 3000);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
