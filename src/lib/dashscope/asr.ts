import { createHash, randomUUID } from "node:crypto";
import type { ProviderResult } from "@/lib/ai/provider-result";
import {
  fetchWithRetry,
  NetworkRetryExhaustedError,
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  isRetryableNetworkError,
} from "@/lib/http/retry";
import { readSseJsonStream } from "@/lib/http/sse";
import { dashScopeRequestPolicy } from "./request-policy";
import { streamTranscriptPostprocess } from "@/lib/dashscope/transcript-postprocess";
import {
  DASHSCOPE_FIXED_BASE_URL,
} from "@/lib/dashscope/fixed-config";
import { DEFAULT_DASHSCOPE_MODELS, DASHSCOPE_ASR_FLASH_MODEL, DASHSCOPE_ASR_FLASH_MAX_SECONDS } from "@/lib/dashscope/model-config";
import { readDashScopeApiKeyForUser } from "@/lib/dashscope/user-credential";
import {
  attachAsrTaskProviderTask,
  deleteAsrTask,
  markAsrTaskCanceled,
  markAsrTaskFailed,
  markAsrTaskRunning,
  markAsrTaskSucceeded,
  checkpointAsrTaskResult,
  readAsrTask,
  readRunningAsrTask,
  reserveAsrTask,
  type AsrCredentialSource,
  type StoredAsrTask,
  type StoredAsrHistoryContext,
} from "@/lib/transcript/db";
import { joinTranscriptText } from "@/lib/transcript/text";
import type { TranscriptSegment } from "@/types/douyin";

type DashScopeConfig = {
  apiKey: string;
  baseUrl: string;
};

export type DashScopeAsrModel = string;
export type DashScopeAsrModelProfile = "e1";

export type DashScopeAsrOptions = {
  diarizationEnabled?: boolean;
  model: DashScopeAsrModel;
  speakerCount?: number;
};

export type DashScopeAsrRuntimeOptions = {
  apiKey?: string;
  apiKeys?: Partial<Record<AsrCredentialSource, string>>;
  clientJobId?: string;
  credentialSource?: AsrCredentialSource;
  historyContext?: StoredAsrHistoryContext;
  authorName?: string;
  title?: string;
  postprocess?: {
    model?: string;
    onStart?: () => void;
  };
  postprocessModels?: Partial<Record<AsrCredentialSource, string>>;
  signal?: AbortSignal;
};

export type DashScopeAsrAudio = {
  durationSeconds?: number;
  objectKey: string;
  signedUrl: string;
};

type TranscriptPayload = {
  content: string;
  emotions?: string[];
  transcriptSegments?: TranscriptSegment[];
};
export type DashScopeAsrJobResult =
  | { historyContext?: StoredAsrHistoryContext; jobId: string; status: "running" }
  | { fallbackEligible?: boolean; historyContext?: StoredAsrHistoryContext; result: ProviderResult; status: "canceled" | "failed" | "successed" };

const DASH_SCOPE_REQUEST_TIMEOUT_MS = 60_000;
const DASH_SCOPE_SUBMIT_TIMEOUT_MS = 15_000;
const DASH_SCOPE_QUERY_TIMEOUT_MS = 20_000;
const DASH_SCOPE_FLASH_TIMEOUT_MS = 120_000;
export const PLATFORM_ASR_QUOTA_SECONDS = 60 * 60;
const NO_SPEECH_DETAIL = "未检测到可识别的语音。暂不支持转录纯静音、仅背景噪声或没有人声的音频。";
const NO_SPEECH_TASK_CODES = new Set([
  "ASR_RESPONSE_HAVE_NO_WORDS",
  "SUCCESS_WITH_NO_VALID_FRAGMENT",
]);
const FALLBACK_PROVIDER_ERROR_CATEGORIES = new Set([
  "accessdenied",
  "allocationquota",
  "arrearage",
  "forbidden",
  "invalidapikey",
  "modelaccessdenied",
  "throttling",
]);

export class AsrQuotaExceededError extends Error {
  constructor() {
    super("平台转录剩余额度不足，无法转录当前音频。请前往设置，配置正确且可用的自定义 API Key 后继续使用。");
  }
}

class DashScopeConfigurationError extends Error {}

class DashScopeRequestError extends Error {
  private constructor(
    message: string,
    readonly kind: "http" | "network",
    readonly providerCode?: string,
    readonly status?: number,
  ) {
    super(message);
  }

  static fromNetwork(error: unknown): DashScopeRequestError {
    const detail = error instanceof Error ? error.message : "未知错误";
    return new DashScopeRequestError(`DashScope 网络请求失败：${detail}`, "network");
  }

  static fromResponse(status: number, payload: unknown): DashScopeRequestError {
    return new DashScopeRequestError(
      formatDashScopeError(status, payload),
      "http",
      readDashScopeErrorCode(payload) ?? undefined,
      status,
    );
  }
}

export async function submitDashScopeAsrJob(
  userId: string,
  workKey: string,
  audio: DashScopeAsrAudio | undefined,
  options: DashScopeAsrOptions,
  runtimeOptions: DashScopeAsrRuntimeOptions = {},
): Promise<DashScopeAsrJobResult> {
  if (!audio?.signedUrl || !audio.objectKey || !audio.durationSeconds) {
    return { status: "failed", result: { ok: false, code: "unavailable", detail: "原声音频资源不可用。" } };
  }

  let reservedJobId: string | undefined;
  let providerResultSaved = false;
  try {
    const credentialSource = runtimeOptions.credentialSource ?? "platform";
    const config = await readDashScopeConfig(
      userId,
      resolveRuntimeApiKey(runtimeOptions, credentialSource),
      runtimeOptions.credentialSource === undefined && runtimeOptions.apiKeys === undefined,
    );
    const normalizedOptions = normalizeDashScopeAsrOptions(options);
    const model = normalizedOptions.model;
    const cacheKey = buildTranscriptCacheKey(model, audio.objectKey, normalizedOptions, credentialSource);
    const existingClientTask = runtimeOptions.clientJobId
      ? await readAsrTask({ id: runtimeOptions.clientJobId, userId })
      : null;
    if (existingClientTask) {
      return readStoredAsrTaskResult(existingClientTask);
    }
    const runningTask = runtimeOptions.clientJobId
      ? null
      : await readRunningAsrTask({ cacheKey, userId });
    if (runningTask) {
      return { status: "running", historyContext: runningTask.historyContext, jobId: runningTask.id };
    }

    const jobId = runtimeOptions.clientJobId ?? randomUUID();
    const historyContext = runtimeOptions.historyContext;
    const taskInput = {
      audioDurationSeconds: audio.durationSeconds,
      cacheKey,
      credentialSource,
      historyContext,
      id: jobId,
      model,
      objectKey: audio.objectKey,
      userId,
      workKey,
    };
    const reserved = await reserveAsrTask(
      taskInput,
      credentialSource === "platform" ? PLATFORM_ASR_QUOTA_SECONDS : undefined,
    );
    if (!reserved) {
      throw new AsrQuotaExceededError();
    }
    reservedJobId = jobId;
    if (model === DASHSCOPE_ASR_FLASH_MODEL) {
      let transcript: TranscriptPayload | null;
      try {
        transcript = await recognizeFlashAudio(config, audio.signedUrl, normalizedOptions, runtimeOptions.signal);
      } catch (error) {
        // A definite rejection of the synchronous transport can use the queryable file transport.
        // Never replay an ambiguous network failure: the provider may already have billed it.
        if (!(error instanceof DashScopeRequestError) || error.status !== 400) throw error;
        normalizedOptions.model = DEFAULT_DASHSCOPE_MODELS.asrE1;
        taskInput.model = normalizedOptions.model;
        taskInput.cacheKey = buildTranscriptCacheKey(taskInput.model, audio.objectKey, normalizedOptions, credentialSource);
        transcript = null;
      }
      if (normalizedOptions.model === model) {
        if (!transcript) {
          const failure = { ok: false as const, code: "no_speech" as const, detail: NO_SPEECH_DETAIL, retryable: false };
          await markAsrTaskFailed(jobId, NO_SPEECH_DETAIL, failure);
          return { status: "failed", result: failure };
        }
        const rawResult = { ...transcript, ok: true as const, asrModel: model };
        providerResultSaved = await checkpointAsrTaskResult(jobId, rawResult);
        if (!providerResultSaved) return { status: "canceled", result: { ok: false, code: "error", detail: "转录任务已取消。" } };
        return await settleTranscript(config, taskInput, transcript, runtimeOptions);
      }
    }
    const taskId = await submitDashScopeAsrTask(config, audio.signedUrl, normalizedOptions, runtimeOptions.signal);
    if (!(await attachAsrTaskProviderTask({ id: jobId, taskId, model: taskInput.model, cacheKey: taskInput.cacheKey }))) {
      await cancelDashScopeAsrTask(config, taskId).catch(() => undefined);
      return { status: "failed", result: { ok: false, code: "error", detail: "转录任务已放弃。" } };
    }
    return { status: "running", historyContext, jobId };
  } catch (error) {
    const failure = toProviderFailure(error);
    if (reservedJobId && !providerResultSaved &&
      (!(error instanceof DashScopeRequestError) || error.kind === "network")) {
      failure.submissionUncertain = true;
      failure.detail = "识别提交确认中断，请先核对服务商记录后重试；避免重复计费。";
    }
    if (reservedJobId && !providerResultSaved) {
      await markAsrTaskFailed(reservedJobId, failure.detail, failure).catch(() => undefined);
    }
    if (error instanceof AsrQuotaExceededError) {
      throw error;
    }
    return {
      status: "failed",
      fallbackEligible: canFallbackSubmission(error, options.model),
      result: failure,
    };
  }
}

export async function transcribeDashScopeAsr(
  userId: string,
  workKey: string,
  audio: DashScopeAsrAudio | undefined,
  options: DashScopeAsrOptions,
  runtimeOptions: DashScopeAsrRuntimeOptions = {},
): Promise<DashScopeAsrJobResult> {
  return await submitDashScopeAsrJob(userId, workKey, audio, options, runtimeOptions);
}

export async function transcribeDashScopeAsrOnce(
  userId: string,
  fileUrl: string,
  options: DashScopeAsrOptions,
  runtimeOptions: DashScopeAsrRuntimeOptions & { title?: string } = {},
): Promise<{ fallbackEligible?: boolean; result: ProviderResult }> {
  const config = await readDashScopeConfig(
    userId,
    runtimeOptions.apiKey,
    runtimeOptions.apiKey === undefined,
  );
  const normalizedOptions = normalizeDashScopeAsrOptions(options);
  let taskId: string | undefined;
  try {
    if (normalizedOptions.model === DASHSCOPE_ASR_FLASH_MODEL) {
      const transcript = await recognizeFlashAudio(config, fileUrl, normalizedOptions, runtimeOptions.signal);
      if (!transcript) return { result: { ok: false, code: "no_speech", detail: NO_SPEECH_DETAIL } };
      return { result: await postprocessTranscript({ apiKey: config.apiKey, model: normalizedOptions.model, runtimeOptions,
        title: runtimeOptions.title, authorName: runtimeOptions.authorName,
        transcript: { ...transcript, ok: true, asrModel: normalizedOptions.model } }) };
    }
    taskId = await submitDashScopeAsrTask(config, fileUrl, normalizedOptions, runtimeOptions.signal);
    for (;;) {
      await waitForNextAsrPoll(runtimeOptions.signal);
      const payload = await queryDashScopeAsrTask(config, taskId, runtimeOptions.signal);
      const status = readTaskStatus(payload);
      if (status === "PENDING" || status === "RUNNING") continue;
      if (status === "FAILED") return { result: readDashScopeTaskFailure(payload) };
      if (status === "CANCELED") {
        return { result: { ok: false, code: "error", detail: formatDashScopeTaskFailure(status, payload) } };
      }
      if (status !== "SUCCEEDED") {
        return {
          result: {
            ok: false,
            code: "invalid_response",
            detail: `DashScope ASR 返回未知任务状态：${status || "空状态"}`,
          },
        };
      }

      const transcript = await readDashScopeTranscript(payload, runtimeOptions.signal);
      if (!transcript) {
        return { result: { ok: false, code: "no_speech", detail: NO_SPEECH_DETAIL } };
      }
      return {
        result: await postprocessTranscript({
          apiKey: config.apiKey,
          model: normalizedOptions.model,
          runtimeOptions,
          title: runtimeOptions.title,
          authorName: runtimeOptions.authorName,
          transcript: {
            asrModel: normalizedOptions.model,
            ok: true,
            content: transcript.content,
            emotions: transcript.emotions,
            transcriptSegments: transcript.transcriptSegments,
          },
        }),
      };
    }
  } catch (error) {
    if (runtimeOptions.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      if (taskId) await cancelDashScopeAsrTask(config, taskId).catch(() => undefined);
      throw error;
    }
    return {
      ...(!taskId && canFallbackSubmission(error, options.model) ? { fallbackEligible: true } : {}),
      result: toProviderFailure(error),
    };
  }
}

function waitForNextAsrPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timeout);
      reject(Object.assign(new Error("转录任务已取消。"), { name: "AbortError" }));
    };
    const timeout = setTimeout(finish, 1_500);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export function parseDashScopeTranscriptPayload(payload: unknown): TranscriptPayload | null {
  if (!payload || typeof payload !== "object") {
    throw new Error("DashScope 转录结果格式无效：结果文件不是 JSON 对象。");
  }

  const transcripts = (payload as Record<string, unknown>).transcripts;
  if (!Array.isArray(transcripts) || transcripts.length === 0) {
    throw new Error("DashScope 转录结果格式无效：缺少 transcripts 数组。");
  }

  const segments = transcripts.flatMap((transcript) => parseTranscriptSegments(transcript));
  const content = joinTranscriptText(segments.map((segment) => segment.text));
  return buildTranscriptPayload(content, segments);
}

function buildTranscriptPayload(content: string, segments: TranscriptSegment[]): TranscriptPayload | null {
  const cleanSegments = segments.filter((segment) => segment.text.trim());
  const transcriptContent = joinTranscriptText(cleanSegments.map((segment) => segment.text)) || content.trim();
  if (!transcriptContent) {
    return null;
  }

  const emotions = readSegmentEmotions(cleanSegments);
  return {
    content: transcriptContent,
    ...(emotions ? { emotions } : {}),
    ...(cleanSegments.length ? { transcriptSegments: cleanSegments } : {}),
  };
}

async function settleDashScopeAsrTask(
  config: DashScopeConfig,
  job: StoredAsrTask,
  taskPayload: unknown,
  runtimeOptions: DashScopeAsrRuntimeOptions,
): Promise<DashScopeAsrJobResult> {
  const status = readTaskStatus(taskPayload);
  if (status === "SUCCEEDED") {
    const transcript = await readDashScopeTranscript(taskPayload, runtimeOptions.signal);
    if (!transcript) {
      const failure = { ok: false as const, code: "no_speech" as const, detail: NO_SPEECH_DETAIL };
      await markAsrTaskFailed(job.id, NO_SPEECH_DETAIL, failure);
      return {
        status: "failed",
        historyContext: job.historyContext,
        result: failure,
      };
    }
    if (!(await checkpointAsrTaskResult(job.id, { ...transcript, ok: true, asrModel: job.model }))) {
      return { status: "canceled", result: { ok: false, code: "error", detail: "转录任务已取消。" } };
    }
    return settleTranscript(config, job, transcript, runtimeOptions);
  }

  if (status === "CANCELED") {
    const detail = formatDashScopeTaskFailure(status, taskPayload);
    await markAsrTaskCanceled(job.id, detail);
    return { status: "canceled", historyContext: job.historyContext, result: { ok: false, code: "error", detail } };
  }

  if (status === "FAILED") {
    const result = readDashScopeTaskFailure(taskPayload);
    await markAsrTaskFailed(job.id, result.detail, result);
    return { status: "failed", historyContext: job.historyContext, result };
  }

  if (status === "PENDING" || status === "RUNNING") {
    await markAsrTaskRunning(job.id);
    return { status: "running", historyContext: job.historyContext, jobId: job.id };
  }

  const detail = `DashScope ASR 返回未知任务状态：${status || "空状态"}`;
  await markAsrTaskFailed(job.id, detail);
  return { status: "failed", historyContext: job.historyContext, result: { ok: false, code: "error", detail } };
}

async function settleTranscript(
  config: DashScopeConfig,
  job: Pick<StoredAsrTask, "id" | "userId" | "model" | "historyContext">,
  transcript: TranscriptPayload,
  runtimeOptions: DashScopeAsrRuntimeOptions,
): Promise<DashScopeAsrJobResult> {
  const model = job.model;
  const result = await postprocessTranscript({
    apiKey: config.apiKey,
    model,
    runtimeOptions,
    title: job.historyContext?.work.caption,
    authorName: job.historyContext?.work.authorName,
    transcript: {
      asrModel: model,
      ok: true,
      content: transcript.content,
      emotions: transcript.emotions,
      transcriptSegments: transcript.transcriptSegments,
    },
  });
  if (result.ok) {
    if ((await markAsrTaskSucceeded(job.id, result)) === false) {
      const settled = await readAsrTask({ id: job.id, userId: job.userId });
      if (settled?.status === "succeeded" && settled.result) {
        return { status: "successed", historyContext: settled.historyContext, result: settled.result };
      }
      return {
        status: "canceled",
        historyContext: job.historyContext,
        result: { ok: false, code: "error", detail: "转录任务已取消。" },
      };
    }
    return { status: "successed", historyContext: job.historyContext, result };
  }

  return { status: "failed", historyContext: job.historyContext, result };
}

export async function refreshDashScopeAsrJobWithOptions(
  userId: string,
  jobId: string,
  runtimeOptions: DashScopeAsrRuntimeOptions = {},
): Promise<DashScopeAsrJobResult | null> {
  const job = await readAsrTask({ id: jobId, userId });
  if (!job) {
    return null;
  }
  if (job.status !== "running") {
    return readStoredAsrTaskResult(job);
  }

  const source = job.credentialSource;
  const config = await readDashScopeConfig(
    userId,
    resolveRuntimeApiKey(runtimeOptions, source),
    runtimeOptions.apiKeys === undefined,
  );
  try {
    const options: DashScopeAsrRuntimeOptions = {
      ...runtimeOptions,
      postprocess: {
        ...runtimeOptions.postprocess,
        model: runtimeOptions.postprocessModels?.[source] ?? runtimeOptions.postprocess?.model,
      },
    };
    if (job.result) return await settleTranscript(config, job, job.result, options);
    if (job.model === DASHSCOPE_ASR_FLASH_MODEL) {
      if (Date.now() - job.updatedAt >= DASH_SCOPE_FLASH_TIMEOUT_MS) {
        const detail = "短音频提交确认中断，无法查询服务商结果；请先核对服务商记录，再决定是否重新转录。";
        const failure = { ok: false as const, code: "error" as const, detail, submissionUncertain: true };
        await markAsrTaskFailed(job.id, detail, failure);
        return { status: "failed", result: failure };
      }
      return readStoredAsrTaskResult(job);
    }
    const payload = await queryDashScopeAsrTask(config, job.taskId, runtimeOptions.signal);
    return await settleDashScopeAsrTask(config, job, payload, options);
  } catch (error) {
    if (runtimeOptions.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    return {
      status: "failed",
      historyContext: job.historyContext,
      result: toProviderFailure(error),
    };
  }
}

export async function cancelDashScopeAsrJob(
  userId: string,
  jobId: string,
  apiKeyOrMap?: string | Partial<Record<AsrCredentialSource, string>>,
): Promise<boolean> {
  const job = await readAsrTask({ id: jobId, userId });
  if (!job) {
    return false;
  }
  if (job.status !== "running" && job.status !== "canceled") {
    return true;
  }

  if (job.status === "running") {
    await markAsrTaskCanceled(job.id);
  }
  if (job.model !== DASHSCOPE_ASR_FLASH_MODEL && !job.taskId.startsWith("pending:")) {
    const apiKey = typeof apiKeyOrMap === "string" ? apiKeyOrMap : apiKeyOrMap?.[job.credentialSource];
    const config = await readDashScopeConfig(userId, apiKey, apiKeyOrMap === undefined);
    try {
      await cancelDashScopeAsrTask(config, job.taskId);
    } catch {
      return false;
    }
  }
  await deleteAsrTask({ id: job.id, userId });
  return true;
}

async function submitDashScopeAsrTask(
  config: DashScopeConfig,
  fileUrl: string,
  options: DashScopeAsrOptions,
  signal?: AbortSignal,
): Promise<string> {
  const response = await dashScopeFetch(config, "/services/audio/asr/transcription", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dashscope-async": "enable",
    },
    body: JSON.stringify({
      model: options.model,
      input: { file_urls: [fileUrl] },
      parameters: buildDashScopeAsrParameters(options),
    }),
    signal,
  }, { retryNetworkErrors: false });
  const payload = await readJson(response);
  if (!response.ok) {
    throw DashScopeRequestError.fromResponse(response.status, payload);
  }

  const taskId = readStringPath(payload, ["output", "task_id"]) || readStringPath(payload, ["task_id"]);
  if (!taskId) {
    throw new Error("DashScope 未返回任务 ID。");
  }
  return taskId;
}

export function buildDashScopeFlashRequest(fileUrl: string, options: DashScopeAsrOptions) {
  return {
    model: options.model,
    input: { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: fileUrl } }] }] },
    parameters: buildDashScopeAsrParameters(options),
  };
}

export function parseDashScopeFlashTranscriptPayload(payload: unknown): TranscriptPayload | null {
  const output = readFlashOutput(payload);
  if (!output || typeof output.text !== "string") throw new Error("DashScope 短音频结果格式无效：缺少 output.text。");
  if (!output.text.trim()) return null;
  const detail = output.output && typeof output.output === "object" ? output.output as Record<string, unknown> : output;
  const sentences = Array.isArray(detail.sentences) ? detail.sentences : detail.sentence ? [detail.sentence] : [];
  return buildTranscriptPayload(output.text, sentences.length ? parseTranscriptSegments({ sentences }) : []);
}

async function recognizeFlashAudio(config: DashScopeConfig, fileUrl: string, options: DashScopeAsrOptions, signal?: AbortSignal) {
  const response = await dashScopeFetch(config, "/services/aigc/multimodal-generation/generation", {
    method: "POST", headers: { "content-type": "application/json", "x-dashscope-sse": "enable" },
    body: JSON.stringify(buildDashScopeFlashRequest(fileUrl, options)), signal,
  }, { retryNetworkErrors: false, timeoutMs: DASH_SCOPE_FLASH_TIMEOUT_MS });
  if (!response.ok) throw DashScopeRequestError.fromResponse(response.status, await readJson(response));
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return parseDashScopeFlashTranscriptPayload(await readJson(response));
  }
  if (!response.body) throw new Error("识别响应缺少数据流。");
  const sentences = new Map<string, Record<string, unknown>>();
  let text = "";
  for await (const packet of readSseJsonStream<Record<string, unknown>>(response.body)) {
    signal?.throwIfAborted();
    if (packet.code) throw DashScopeRequestError.fromResponse(response.status, packet);
    const output = readFlashOutput(packet);
    if (!output) continue;
    if (typeof output.text === "string") text = output.text;
    const detail = output.output && typeof output.output === "object" ? output.output as Record<string, unknown> : output;
    const updates = Array.isArray(detail.sentences) ? detail.sentences : detail.sentence ? [detail.sentence] : [];
    for (const value of updates) {
      const sentence = value as Record<string, unknown>;
      const key = `${sentence.channel_id ?? 0}:${sentence.sentence_id ?? sentence.begin_time}`;
      sentences.set(key, sentence);
    }
  }
  if ([...sentences.values()].some(sentence => sentence.sentence_end === false)) {
    throw new Error("识别数据流提前结束，尚未返回完整句子。");
  }
  const segments = parseTranscriptSegments({ sentences: [...sentences.values()].sort((a, b) => Number(a.begin_time) - Number(b.begin_time)) });
  return buildTranscriptPayload(text, segments);
}

function readFlashOutput(payload: unknown): Record<string, unknown> | undefined {
  return payload && typeof payload === "object" ? (payload as { output?: Record<string, unknown> }).output : undefined;
}

async function queryDashScopeAsrTask(config: DashScopeConfig, taskId: string, signal?: AbortSignal): Promise<unknown> {
  const response = await dashScopeFetch(config, `/tasks/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: {
      "content-type": "application/json",
    },
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw DashScopeRequestError.fromResponse(response.status, payload);
  }

  return payload;
}

async function cancelDashScopeAsrTask(config: DashScopeConfig, taskId: string): Promise<void> {
  const response = await dashScopeFetch(config, `/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`DashScope 取消任务失败：HTTP ${response.status}`);
  }
}

function readTaskStatus(payload: unknown): string {
  return readStringPath(payload, ["output", "task_status"]) ||
    readStringPath(payload, ["data", "task_status"]) ||
    readStringPath(payload, ["task_status"]) ||
    "";
}

async function readDashScopeTranscript(taskPayload: unknown, signal?: AbortSignal): Promise<TranscriptPayload | null> {
  const resultUrls = readTranscriptionUrls(taskPayload);

  const transcripts: TranscriptPayload[] = [];
  for (const url of resultUrls) {
    const response = await fetchWithRetry(url, {
      method: "GET",
      retry: {
        timeoutMs: DASH_SCOPE_REQUEST_TIMEOUT_MS,
      },
      signal,
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new Error(`下载 DashScope 转录结果失败：HTTP ${response.status}`);
    }

    const transcript = parseDashScopeTranscriptPayload(payload);
    if (transcript) {
      transcripts.push(transcript);
    }
  }

  const content = joinTranscriptText(transcripts.map((transcript) => transcript.content));
  if (!content) {
    return null;
  }

  const transcriptSegments = transcripts.flatMap((transcript) => transcript.transcriptSegments ?? []);
  const emotions = [...new Set(transcripts.flatMap((transcript) => transcript.emotions ?? []))];
  const transcript = buildTranscriptPayload(content, transcriptSegments);
  if (!transcript) {
    return null;
  }

  return {
    ...transcript,
    emotions: transcript.emotions ?? (emotions.length > 0 ? emotions : undefined),
  };
}

async function dashScopeFetch(
  config: DashScopeConfig,
  path: string,
  init: RequestInit,
  retryOptions: { retryNetworkErrors?: boolean; timeoutMs?: number } = {},
): Promise<Response> {
  try {
    const model = init.method === "GET" ? "query" : typeof init.body === "string" ? (JSON.parse(init.body) as { model?: string }).model : undefined;
    if (model) await dashScopeRequestPolicy.beforeRequest(model, init.signal);
    return await fetchWithRetry(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        ...init.headers,
      },
      retry: {
        retryNetworkErrors: retryOptions.retryNetworkErrors,
        timeoutMs: retryOptions.timeoutMs ?? (init.method === "GET" ? DASH_SCOPE_QUERY_TIMEOUT_MS : DASH_SCOPE_SUBMIT_TIMEOUT_MS),
      },
    });
  } catch (error) {
    if (init.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    if (error instanceof NetworkRetryExhaustedError || error instanceof DashScopeRequestError) {
      throw error;
    }
    throw DashScopeRequestError.fromNetwork(error);
  }
}

function readStoredAsrTaskResult(job: StoredAsrTask): DashScopeAsrJobResult {
  if (job.status === "succeeded") {
    if (job.result) return { status: "successed", historyContext: job.historyContext, result: job.result };
    return { status: "failed", result: { ok: false, code: "error", detail: "转录任务已完成，请重新发起转录。" } };
  }
  if (job.status === "failed") {
    return {
      status: "failed",
      historyContext: job.historyContext,
      result: job.failure ?? { ok: false, code: "error", detail: job.errorDetail ?? "转录文本失败。" },
    };
  }
  if (job.status === "canceled") {
    return {
      status: "canceled",
      historyContext: job.historyContext,
      result: { ok: false, code: "error", detail: job.errorDetail ?? "转录任务已放弃。" },
    };
  }

  return { status: "running", historyContext: job.historyContext, jobId: job.id };
}

async function postprocessTranscript(input: {
  apiKey: string;
  model: DashScopeAsrModel;
  runtimeOptions: DashScopeAsrRuntimeOptions;
  title?: string;
  authorName?: string;
  transcript: Extract<ProviderResult, { ok: true }>;
}): Promise<ProviderResult> {
  input.runtimeOptions.postprocess?.onStart?.();
  const result = await streamTranscriptPostprocess({
    apiKey: input.apiKey,
    content: input.transcript.content,
    model: input.runtimeOptions.postprocess?.model ?? DEFAULT_DASHSCOPE_MODELS.transcriptPostprocess,
    segments: input.transcript.transcriptSegments,
    signal: input.runtimeOptions.signal,
    title: input.title,
    authorName: input.authorName,
  });

  if (result.ok) {
    return {
      ...result,
      asrModel: input.model,
    };
  }
  if (result.code === "invalid_response") {
    return {
      ...input.transcript,
      asrModel: input.model,
    };
  }
  return result;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseTranscriptSegments(payload: unknown): TranscriptSegment[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("DashScope 转录结果格式无效：transcript 不是对象。");
  }
  const sentences = (payload as Record<string, unknown>).sentences;
  if (!Array.isArray(sentences)) {
    throw new Error("DashScope 转录结果格式无效：缺少 sentences 数组。");
  }
  const speakerLabels = new Map<string, string>();

  return sentences.map((sentence): TranscriptSegment => {
    const text = readRequiredStringField(sentence, "text", "sentence.text");
    const emotion = readStringField(sentence, "emotion");
    const startSeconds = readRequiredMillisecondsField(sentence, "begin_time", "sentence.begin_time") / 1000;
    const endSeconds = readRequiredMillisecondsField(sentence, "end_time", "sentence.end_time") / 1000;
    if (endSeconds < startSeconds) {
      throw new Error("DashScope 转录结果格式无效：sentence.end_time 小于 begin_time。");
    }

    return {
      endSeconds: roundSeconds(endSeconds),
      ...(emotion ? { emotion } : {}),
      speakerId: readSpeakerId(sentence, speakerLabels) ?? undefined,
      startSeconds: roundSeconds(startSeconds),
      text,
    };
  });
}

function readSegmentEmotions(segments: TranscriptSegment[]): string[] | undefined {
  const emotions = [...new Set(segments.map((segment) => segment.emotion).filter((emotion): emotion is string => Boolean(emotion)))];
  return emotions.length > 0 ? emotions : undefined;
}

function readTranscriptionUrls(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    throw new Error("DashScope 任务结果格式无效：响应不是 JSON 对象。");
  }
  const output = (value as Record<string, unknown>).output;
  if (!output || typeof output !== "object") {
    throw new Error("DashScope 任务结果格式无效：缺少 output 对象。");
  }

  const resultUrl = readStringPath(output, ["result", "transcription_url"]);
  if (resultUrl) {
    return [resultUrl];
  }

  const results = (output as Record<string, unknown>).results;
  if (Array.isArray(results) && results.length > 0) {
    const urls = results.map((result, index) =>
      readRequiredStringField(result, "transcription_url", `output.results[${index}].transcription_url`),
    );
    return [...new Set(urls)];
  }

  throw new Error("DashScope 任务结果格式无效：缺少 output.result.transcription_url 或 output.results[].transcription_url。");
}

async function readDashScopeConfig(
  userId: string,
  explicitApiKey?: string,
  allowUserFallback = true,
): Promise<DashScopeConfig> {
  const apiKey = explicitApiKey?.trim() || (allowUserFallback ? await readDashScopeApiKeyForUser(userId) : undefined);
  if (!apiKey) {
    throw new DashScopeConfigurationError("DASHSCOPE_API_KEY 未配置。");
  }

  return {
    apiKey,
    baseUrl: DASHSCOPE_FIXED_BASE_URL,
  };
}

function resolveRuntimeApiKey(
  runtimeOptions: DashScopeAsrRuntimeOptions,
  source: AsrCredentialSource,
): string | undefined {
  return runtimeOptions.apiKeys?.[source] ?? runtimeOptions.apiKey;
}

function buildTranscriptCacheKey(
  model: string,
  objectKey: string,
  options: DashScopeAsrOptions,
  credentialSource: AsrCredentialSource,
): string {
  return `${credentialSource}:${model}:asr-v6:${sha256(JSON.stringify([objectKey, options]))}`;
}

function readStringField(value: unknown, field: string): string | null {
  const fieldValue = value && typeof value === "object"
    ? (value as Record<string, unknown>)[field]
    : null;
  return typeof fieldValue === "string" && fieldValue.trim() ? fieldValue.trim() : null;
}

function readRequiredStringField(value: unknown, field: string, label: string): string {
  const fieldValue = readStringField(value, field);
  if (!fieldValue) {
    throw new Error(`DashScope 转录结果格式无效：缺少 ${label}。`);
  }
  return fieldValue;
}

function readStringPath(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function readRequiredMillisecondsField(value: unknown, field: string, label: string): number {
  if (!value || typeof value !== "object") {
    throw new Error(`DashScope 转录结果格式无效：缺少 ${label}。`);
  }

  const record = value as Record<string, unknown>;
  const rawValue = record[field];
  const parsed = typeof rawValue === "number" ? rawValue : Number(rawValue);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }

  throw new Error(`DashScope 转录结果格式无效：${label} 不是有效毫秒时间。`);
}

function readSpeakerId(value: unknown, labels: Map<string, string>): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const rawValue = record.speaker_id ?? record.speakerId ?? record.speaker;
  let rawSpeakerId: string | null = null;
  if (typeof rawValue === "string" && rawValue.trim()) {
    rawSpeakerId = normalizeSpeakerId(rawValue);
  } else if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    rawSpeakerId = normalizeSpeakerId(String(rawValue));
  }
  if (!rawSpeakerId) {
    return null;
  }

  const existing = labels.get(rawSpeakerId);
  if (existing) {
    return existing;
  }

  const nextLabel = String(labels.size + 1);
  labels.set(rawSpeakerId, nextLabel);
  return nextLabel;
}

function normalizeSpeakerId(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^speaker[_-\s]*/i, "") || trimmed;
}

export function buildDashScopeAsrParameters(
  options: DashScopeAsrOptions,
): Record<string, unknown> {
  const flash = options.model === DASHSCOPE_ASR_FLASH_MODEL;
  const parameters: Record<string, unknown> = flash ? { format: "m4a" } : { channel_id: [0] };
  if (options.diarizationEnabled) {
    parameters[flash ? "speaker_diarization_enabled" : "diarization_enabled"] = true;
    if (!flash && options.speakerCount !== undefined) {
      parameters.speaker_count = options.speakerCount;
    }
  }
  return parameters;
}

function normalizeDashScopeAsrOptions(
  options: DashScopeAsrOptions,
): DashScopeAsrOptions {
  const normalized: DashScopeAsrOptions = {
    model: options.model,
  };
  if (options.diarizationEnabled) {
    normalized.diarizationEnabled = true;
    if (Number.isInteger(options.speakerCount)) {
      normalized.speakerCount = options.speakerCount;
    }
  }

  return normalized;
}
export function getDashScopeAsrModel(
  durationSeconds: number | undefined,
  models = DEFAULT_DASHSCOPE_MODELS,
): DashScopeAsrModel {
  return durationSeconds !== undefined && durationSeconds > 0 && durationSeconds <= DASHSCOPE_ASR_FLASH_MAX_SECONDS
    ? DASHSCOPE_ASR_FLASH_MODEL : models.asrE1;
}

function formatDashScopeError(status: number, payload: unknown): string {
  const message =
    readStringField(payload, "message") ||
    readStringPath(payload, ["error", "message"]) ||
    readStringPath(payload, ["output", "message"]);

  if (status === 401 || status === 403) {
    return "DashScope 认证失败：请检查 DASHSCOPE_API_KEY、业务空间和模型权限。";
  }

  return `DashScope 请求失败：HTTP ${status}${message ? `，${message}` : ""}`;
}

function readDashScopeErrorCode(payload: unknown): string | null {
  return readStringField(payload, "code") ||
    readStringPath(payload, ["error", "code"]) ||
    readStringPath(payload, ["output", "code"]);
}

function formatDashScopeTaskFailure(status: string, payload: unknown): string {
  const message =
    readStringPath(payload, ["output", "message"]) ||
    readStringPath(payload, ["output", "error_message"]) ||
    readStringPath(payload, ["data", "output_result", "output", "message"]) ||
    readStringPath(payload, ["data", "output_result", "output", "code"]) ||
    readStringField(payload, "message");
  return `DashScope ASR 任务${status === "FAILED" ? "失败" : "未完成"}${message ? `：${message}` : "。"}`;
}

function readDashScopeTaskFailure(payload: unknown): Extract<ProviderResult, { ok: false }> {
  const providerCode = readStringPath(payload, ["output", "code"]);
  if (providerCode && NO_SPEECH_TASK_CODES.has(providerCode)) {
    return { ok: false, code: "no_speech", detail: NO_SPEECH_DETAIL };
  }
  return { ok: false, code: "error", detail: formatDashScopeTaskFailure("FAILED", payload), retryable: true };
}

function isFallbackEligibleRequestError(error: unknown): boolean {
  if (!(error instanceof DashScopeRequestError)) {
    return false;
  }
  if (error.kind === "network") {
    return true;
  }
  if (error.status && ([401, 402, 403, 408, 409, 429].includes(error.status) || error.status >= 500)) {
    return true;
  }

  const category = error.providerCode?.toLowerCase().split(/[.:]/u, 1)[0];
  return Boolean(category && FALLBACK_PROVIDER_ERROR_CATEGORIES.has(category));
}

function canFallbackSubmission(error: unknown, model: string): boolean {
  // A synchronous request may have completed and been billed even when its response was lost.
  if (model === DASHSCOPE_ASR_FLASH_MODEL && (error instanceof NetworkRetryExhaustedError ||
    (error instanceof DashScopeRequestError && error.kind === "network"))) return false;
  return isFallbackEligibleRequestError(error);
}

function toProviderFailure(error: unknown): Extract<ProviderResult, { ok: false }> {
  if (isRetryableNetworkError(error) ||
    (error instanceof DashScopeRequestError && error.kind === "network")) {
    return {
      ok: false,
      code: NETWORK_RETRY_ERROR_CODE,
      detail: NETWORK_RETRY_ERROR_MESSAGE,
      retryable: true,
    };
  }

  const detail = error instanceof Error ? error.message : "转录文本失败。";
  return {
    ok: false,
    code: error instanceof DashScopeConfigurationError ||
      (error instanceof DashScopeRequestError && (error.status === 401 || error.status === 403))
      ? "not_configured"
      : "error",
    detail,
    retryable: error instanceof DashScopeRequestError ? error.status === 429 || (error.status ?? 0) >= 500 || error.status === 200 : undefined,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
