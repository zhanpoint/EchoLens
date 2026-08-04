import { createHash, randomUUID } from "node:crypto";
import type { ProviderResult } from "@/lib/ai/provider-result";
import {
  fetchWithRetry,
  NetworkRetryExhaustedError,
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
} from "@/lib/http/retry";
import { streamTranscriptPostprocess } from "@/lib/dashscope/transcript-postprocess";
import {
  DASHSCOPE_FIXED_BASE_URL,
} from "@/lib/dashscope/fixed-config";
import { DEFAULT_DASHSCOPE_MODELS } from "@/lib/dashscope/model-config";
import { readDashScopeApiKeyForUser } from "@/lib/dashscope/user-credential";
import {
  attachAsrTaskProviderTask,
  deleteAsrTask,
  markAsrTaskCanceled,
  markAsrTaskFailed,
  markAsrTaskRunning,
  markAsrTaskSucceeded,
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
export type DashScopeAsrModelProfile = "e1" | "e2" | "e3";

export type DashScopeAsrOptions = {
  diarizationEnabled?: boolean;
  enableItn?: boolean;
  model: DashScopeAsrModel;
  profile: DashScopeAsrModelProfile;
  specialWordFilter?: DashScopeSpecialWordFilter;
  speakerCount?: number;
};

export type DashScopeAsrRuntimeOptions = {
  apiKey?: string;
  apiKeys?: Partial<Record<AsrCredentialSource, string>>;
  clientJobId?: string;
  credentialSource?: AsrCredentialSource;
  historyContext?: StoredAsrHistoryContext;
  postprocess?: {
    model?: string;
    onStart?: () => void;
  };
  postprocessModels?: Partial<Record<AsrCredentialSource, string>>;
  signal?: AbortSignal;
};

export type DashScopeSpecialWordFilter = {
  filter_with_empty?: DashScopeSensitiveWordList;
  filter_with_signed?: DashScopeSensitiveWordList;
  system_reserved_filter?: boolean;
};
export type DashScopeAsrAudio = {
  durationSeconds?: number;
  objectKey: string;
  signedUrl: string;
};

type DashScopeSensitiveWordList = {
  word_list: string[];
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
    const taskId = await submitDashScopeAsrTask(config, audio.signedUrl, normalizedOptions, runtimeOptions.signal);
    if (!(await attachAsrTaskProviderTask({ id: jobId, taskId }))) {
      await cancelDashScopeAsrTask(config, taskId).catch(() => undefined);
      return { status: "failed", result: { ok: false, code: "error", detail: "转录任务已放弃。" } };
    }
    return { status: "running", historyContext, jobId };
  } catch (error) {
    if (reservedJobId) {
      const detail = error instanceof Error ? error.message : "转录任务提交失败。";
      await markAsrTaskFailed(reservedJobId, detail).catch(() => undefined);
    }
    if (error instanceof AsrQuotaExceededError) {
      throw error;
    }
    return {
      status: "failed",
      fallbackEligible: isFallbackEligibleRequestError(error),
      result: toProviderFailure(error),
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
      await markAsrTaskFailed(job.id, NO_SPEECH_DETAIL);
      return {
        status: "failed",
        historyContext: job.historyContext,
        result: { ok: false, code: "no_speech", detail: NO_SPEECH_DETAIL },
      };
    }
    const model = job.model;
    const result = await postprocessTranscript({
      apiKey: config.apiKey,
      model,
      runtimeOptions,
      title: job.historyContext?.work.caption,
      transcript: {
        asrModel: model,
        ok: true,
        content: transcript.content,
        emotions: transcript.emotions,
        transcriptSegments: transcript.transcriptSegments,
      },
    });
    if (result.ok) {
      if ((await markAsrTaskSucceeded(job.id)) === false) {
        return {
          status: "canceled",
          historyContext: job.historyContext,
          result: { ok: false, code: "error", detail: "转录任务已取消。" },
        };
      }
      return { status: "successed", historyContext: job.historyContext, result };
    }

    await markAsrTaskFailed(job.id, result.detail);
    return { status: "failed", historyContext: job.historyContext, result };
  }

  if (status === "CANCELED") {
    const detail = formatDashScopeTaskFailure(status, taskPayload);
    await markAsrTaskCanceled(job.id, detail);
    return { status: "canceled", historyContext: job.historyContext, result: { ok: false, code: "error", detail } };
  }

  if (status === "FAILED") {
    const result = readDashScopeTaskFailure(taskPayload);
    await markAsrTaskFailed(job.id, result.detail);
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

export async function refreshDashScopeAsrJob(userId: string, jobId: string): Promise<DashScopeAsrJobResult | null> {
  return await refreshDashScopeAsrJobWithOptions(userId, jobId);
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
    const payload = await queryDashScopeAsrTask(config, job.taskId, runtimeOptions.signal);
    return await settleDashScopeAsrTask(config, job, payload, {
      ...runtimeOptions,
      postprocess: {
        ...runtimeOptions.postprocess,
        model: runtimeOptions.postprocessModels?.[source] ?? runtimeOptions.postprocess?.model,
      },
    });
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
  if (!job.taskId.startsWith("pending:")) {
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
      input: buildDashScopeAsrInput(options, fileUrl),
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
  retryOptions: { retryNetworkErrors?: boolean } = {},
): Promise<Response> {
  try {
    return await fetchWithRetry(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        ...init.headers,
      },
      retry: {
        retryNetworkErrors: retryOptions.retryNetworkErrors,
        timeoutMs: init.method === "GET" ? DASH_SCOPE_QUERY_TIMEOUT_MS : DASH_SCOPE_SUBMIT_TIMEOUT_MS,
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
    return { status: "failed", result: { ok: false, code: "error", detail: "转录任务已完成，请重新发起转录。" } };
  }
  if (job.status === "failed") {
    return {
      status: "failed",
      historyContext: job.historyContext,
      result: { ok: false, code: "error", detail: job.errorDetail ?? "转录文本失败。" },
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
  model = options.model,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = options.profile === "e1"
    ? {
        enable_words: false,
        ...(options.enableItn ? { enable_itn: true } : {}),
      }
    : options.profile === "e3"
      ? {
          channel_id: [0],
          ...(options.enableItn ? { enable_itn: true } : {}),
        }
      : { channel_id: [0] };

  if (options.diarizationEnabled) {
    if (options.profile !== "e2" && options.profile !== "e3") {
      throw new Error(`当前 ASR profile ${options.profile} 的模型 ${model} 不支持说话人分离，请切换到支持说话人分离的 ASR profile。`);
    }
    parameters.diarization_enabled = true;
    if (options.speakerCount !== undefined) {
      parameters.speaker_count = options.speakerCount;
    }
  }

  if (options.specialWordFilter) {
    if (options.profile !== "e2") {
      throw new Error(`当前 ASR profile ${options.profile} 的模型 ${model} 不支持敏感词过滤，请切换到支持敏感词过滤的 ASR profile。`);
    }
    parameters.special_word_filter = JSON.stringify(options.specialWordFilter);
  }

  return parameters;
}

function normalizeDashScopeAsrOptions(
  options: DashScopeAsrOptions,
): DashScopeAsrOptions {
  const normalized: DashScopeAsrOptions = {
    model: options.model,
    profile: options.profile,
  };

  if (options.enableItn && (options.profile === "e1" || options.profile === "e3")) {
    normalized.enableItn = true;
  }

  if (options.diarizationEnabled && (options.profile === "e2" || options.profile === "e3")) {
    normalized.diarizationEnabled = true;
    if (Number.isInteger(options.speakerCount)) {
      normalized.speakerCount = options.speakerCount;
    }
  }

  const specialWordFilter = normalizeSpecialWordFilter(options.specialWordFilter);
  if (specialWordFilter && options.profile === "e2") {
    normalized.specialWordFilter = specialWordFilter;
  }

  return normalized;
}

function normalizeSpecialWordFilter(
  filter: DashScopeSpecialWordFilter | undefined,
): DashScopeSpecialWordFilter | undefined {
  if (!filter) {
    return undefined;
  }

  const normalized: DashScopeSpecialWordFilter = {
    system_reserved_filter: filter.system_reserved_filter ?? true,
  };
  const signedWords = normalizeSensitiveWordList(filter.filter_with_signed?.word_list);
  const emptyWords = normalizeSensitiveWordList(filter.filter_with_empty?.word_list);
  if (signedWords.length > 0) {
    normalized.filter_with_signed = { word_list: signedWords };
  }
  if (emptyWords.length > 0) {
    normalized.filter_with_empty = { word_list: emptyWords };
  }

  return normalized;
}

function normalizeSensitiveWordList(wordList: string[] | undefined): string[] {
  if (!wordList) {
    return [];
  }

  return [...new Set(wordList.map((word) => word.trim()).filter(Boolean))];
}

function buildDashScopeAsrInput(options: DashScopeAsrOptions, fileUrl: string): Record<string, unknown> {
  return options.profile === "e2"
    ? { file_urls: [fileUrl] }
    : { file_url: fileUrl };
}

export function getDashScopeAsrModelForProfile(
  profile: DashScopeAsrModelProfile,
  models = DEFAULT_DASHSCOPE_MODELS,
): DashScopeAsrModel {
  if (profile === "e1") return models.asrE1;
  if (profile === "e2") return models.asrE2;
  return models.asrE3 ?? "qwen-audio-3.0-asr-flash-filetrans";
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
  return { ok: false, code: "error", detail: formatDashScopeTaskFailure("FAILED", payload) };
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

function toProviderFailure(error: unknown): Extract<ProviderResult, { ok: false }> {
  if (error instanceof NetworkRetryExhaustedError ||
    (error instanceof DashScopeRequestError && error.kind === "network")) {
    return {
      ok: false,
      code: NETWORK_RETRY_ERROR_CODE,
      detail: NETWORK_RETRY_ERROR_MESSAGE,
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
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
