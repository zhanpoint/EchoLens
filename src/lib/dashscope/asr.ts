import { createHash, randomUUID } from "node:crypto";
import type { ProviderResult } from "@/lib/ai/provider-result";
import { fetchWithRetry } from "@/lib/http/retry";
import type { UploadedAsrAudio } from "@/lib/oss/asr-audio";
import { streamQwenTranscriptPostprocess } from "@/lib/dashscope/transcript-postprocess";
import {
  attachAsrTaskProviderTask,
  isAsrJobCancellationRequested,
  markAsrTaskCanceled,
  markAsrTaskFailed,
  markAsrTaskRunning,
  markAsrTaskSucceeded,
  nextAsrQuotaResetAt,
  readAsrTask,
  readDailySucceededAsrDurationSeconds,
  readRunningAsrTask,
  reserveAsrTask,
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
export type DashScopeAsrModelProfile = "e1" | "e2";

export type DashScopeAsrOptions = {
  diarizationEnabled?: boolean;
  enableItn?: boolean;
  model: DashScopeAsrModel;
  profile: DashScopeAsrModelProfile;
  specialWordFilter?: DashScopeSpecialWordFilter;
  speakerCount?: number;
};

export type DashScopeAsrRuntimeOptions = {
  clientJobId?: string;
  historyContext?: StoredAsrHistoryContext;
  postprocess?: {
    onStart?: () => void;
  };
  signal?: AbortSignal;
};

export type DashScopeSpecialWordFilter = {
  filter_with_empty?: DashScopeSensitiveWordList;
  filter_with_signed?: DashScopeSensitiveWordList;
  system_reserved_filter?: boolean;
};
export type DashScopeAsrAudio = UploadedAsrAudio & {
  durationSeconds?: number;
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
  | { historyContext?: StoredAsrHistoryContext; result: ProviderResult; status: "canceled" | "failed" | "successed" };

const DASH_SCOPE_REQUEST_TIMEOUT_MS = 60_000;
const DASH_SCOPE_SUBMIT_TIMEOUT_MS = 15_000;
const DASH_SCOPE_SUBMIT_ATTEMPTS = 2;
const DASH_SCOPE_QUERY_TIMEOUT_MS = 20_000;
const DAILY_TRANSCRIPTION_QUOTA_SECONDS = 5 * 60 * 60;

export class DailyAsrQuotaExceededError extends Error {
  constructor(readonly resetAt: number) {
    super("您已达到今日 5 小时语音转录额度，请明天再继续使用。");
  }
}

export async function submitDashScopeAsrJob(
  userId: string,
  workKey: string,
  audio: DashScopeAsrAudio | undefined,
  options: DashScopeAsrOptions,
  runtimeOptions: DashScopeAsrRuntimeOptions = {},
): Promise<DashScopeAsrJobResult> {
  if (!audio?.signedUrl || !audio.objectKey) {
    return { status: "failed", result: { ok: false, code: "unavailable", detail: "原声音频缓存未就绪。" } };
  }

  try {
    const config = readDashScopeConfig();
    const normalizedOptions = normalizeDashScopeAsrOptions(options);
    const model = normalizedOptions.model;
    const cacheKey = buildTranscriptCacheKey(model, audio.objectKey, normalizedOptions);
    const runningTask = readRunningAsrTask({ cacheKey, userId });
    if (runningTask) {
      return { status: "running", historyContext: runningTask.historyContext, jobId: runningTask.id };
    }

    const jobId = runtimeOptions.clientJobId ?? randomUUID();
    const historyContext = runtimeOptions.historyContext;
    if (isAsrJobCancellationRequested({ id: jobId, userId })) {
      return { status: "failed", result: { ok: false, code: "error", detail: "转录任务已放弃。" } };
    }
    const taskInput = {
      audioDurationSeconds: audio.durationSeconds ?? 0,
      cacheKey,
      historyContext,
      id: jobId,
      model,
      objectKey: audio.objectKey,
      userId,
      workKey,
    };
    if (audio.durationSeconds && audio.durationSeconds > 0) {
      assertDailyAsrQuotaAvailable(userId, audio.durationSeconds);
    }
    reserveAsrTask(taskInput);
    if (isAsrJobCancellationRequested({ id: jobId, userId })) {
      markAsrTaskCanceled(jobId);
      return { status: "failed", result: { ok: false, code: "error", detail: "转录任务已放弃。" } };
    }
    const taskId = await submitDashScopeAsrTask(config, audio.signedUrl, normalizedOptions, runtimeOptions.signal);
    if (isAsrJobCancellationRequested({ id: jobId, userId })) {
      markAsrTaskCanceled(jobId);
      await cancelDashScopeAsrTask(taskId).catch(() => undefined);
      return { status: "failed", result: { ok: false, code: "error", detail: "转录任务已放弃。" } };
    }
    if (!attachAsrTaskProviderTask({ id: jobId, taskId })) {
      await cancelDashScopeAsrTask(taskId).catch(() => undefined);
      return { status: "failed", result: { ok: false, code: "error", detail: "转录任务已放弃。" } };
    }
    return { status: "running", historyContext, jobId };
  } catch (error) {
    if (error instanceof DailyAsrQuotaExceededError) {
      throw error;
    }
    return { status: "failed", result: toProviderFailure(error) };
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
  job: StoredAsrTask,
  taskPayload: unknown,
  runtimeOptions: DashScopeAsrRuntimeOptions,
): Promise<DashScopeAsrJobResult> {
  const status = readTaskStatus(taskPayload);
  if (status === "SUCCEEDED") {
    const transcript = await readDashScopeTranscript(taskPayload, runtimeOptions.signal);
    const model = job.model;
    const result = await postprocessTranscript({
      model,
      runtimeOptions,
      transcript: {
        asrModel: model,
        ok: true,
        content: transcript.content,
        emotions: transcript.emotions,
        transcriptSegments: transcript.transcriptSegments,
      },
    });
    if (result.ok) {
      markAsrTaskSucceeded(job.id);
      return { status: "successed", historyContext: job.historyContext, result };
    }

    markAsrTaskFailed(job.id, result.detail);
    return { status: "failed", historyContext: job.historyContext, result };
  }

  if (status === "CANCELED") {
    const detail = formatDashScopeTaskFailure(status, taskPayload);
    markAsrTaskCanceled(job.id, detail);
    return { status: "canceled", historyContext: job.historyContext, result: { ok: false, code: "error", detail } };
  }

  if (status === "FAILED") {
    const detail = formatDashScopeTaskFailure(status, taskPayload);
    markAsrTaskFailed(job.id, detail);
    return { status: "failed", historyContext: job.historyContext, result: { ok: false, code: "error", detail } };
  }

  if (status === "PENDING" || status === "RUNNING") {
    markAsrTaskRunning(job.id);
    return { status: "running", historyContext: job.historyContext, jobId: job.id };
  }

  const detail = `DashScope ASR 返回未知任务状态：${status || "空状态"}`;
  markAsrTaskFailed(job.id, detail);
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
  const job = readAsrTask({ id: jobId, userId });
  if (!job) {
    return null;
  }
  if (job.status !== "running") {
    return readStoredAsrTaskResult(job);
  }

  const payload = await queryDashScopeAsrTask(job.taskId, runtimeOptions.signal);
  return await settleDashScopeAsrTask(job, payload, runtimeOptions);
}

export async function cancelDashScopeAsrJob(userId: string, jobId: string): Promise<boolean> {
  const job = readAsrTask({ id: jobId, userId });
  if (!job) {
    return false;
  }
  if (job.status !== "running") {
    return true;
  }

  markAsrTaskCanceled(job.id);
  if (!job.taskId.startsWith("pending:")) {
    await cancelDashScopeAsrTask(job.taskId).catch(() => undefined);
  }
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
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(formatDashScopeError(response.status, payload));
  }

  const taskId = readStringPath(payload, ["output", "task_id"]) || readStringPath(payload, ["task_id"]);
  if (!taskId) {
    throw new Error("DashScope 未返回任务 ID。");
  }
  return taskId;
}

async function queryDashScopeAsrTask(taskId: string, signal?: AbortSignal): Promise<unknown> {
  const config = readDashScopeConfig();
  const response = await dashScopeFetch(config, `/tasks/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: {
      "content-type": "application/json",
    },
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(formatDashScopeError(response.status, payload));
  }

  return payload;
}

async function cancelDashScopeAsrTask(taskId: string): Promise<void> {
  const config = readDashScopeConfig();
  const response = await dashScopeFetch(config, `/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
  });
  await response.body?.cancel();
}

function readTaskStatus(payload: unknown): string {
  return readStringPath(payload, ["output", "task_status"]) ||
    readStringPath(payload, ["data", "task_status"]) ||
    readStringPath(payload, ["task_status"]) ||
    "";
}

async function readDashScopeTranscript(taskPayload: unknown, signal?: AbortSignal): Promise<TranscriptPayload> {
  const resultUrls = readTranscriptionUrls(taskPayload);

  const transcripts: TranscriptPayload[] = [];
  for (const url of resultUrls) {
    const response = await fetchWithRetry(url, {
      method: "GET",
      retry: {
        attempts: 2,
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
    throw new Error("DashScope 没有识别到可用转录文本。");
  }

  const transcriptSegments = transcripts.flatMap((transcript) => transcript.transcriptSegments ?? []);
  const emotions = [...new Set(transcripts.flatMap((transcript) => transcript.emotions ?? []))];
  const transcript = buildTranscriptPayload(content, transcriptSegments);
  if (!transcript) {
    throw new Error("DashScope 没有识别到可用转录文本。");
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
): Promise<Response> {
  try {
    return await fetchWithRetry(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        ...init.headers,
      },
      retry: {
        attempts: DASH_SCOPE_SUBMIT_ATTEMPTS,
        timeoutMs: init.method === "GET" ? DASH_SCOPE_QUERY_TIMEOUT_MS : DASH_SCOPE_SUBMIT_TIMEOUT_MS,
      },
    });
  } catch (error) {
    throw new Error(`DashScope 网络请求失败：${error instanceof Error ? error.message : "未知错误"}`);
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
  model: DashScopeAsrModel;
  runtimeOptions: DashScopeAsrRuntimeOptions;
  transcript: Extract<ProviderResult, { ok: true }>;
}): Promise<ProviderResult> {
  input.runtimeOptions.postprocess?.onStart?.();
  const result = await streamQwenTranscriptPostprocess({
    content: input.transcript.content,
    segments: input.transcript.transcriptSegments,
    signal: input.runtimeOptions.signal,
  });

  return result.ok
    ? {
        ...result,
        asrModel: input.model,
      }
    : result;
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

function readDashScopeConfig(): DashScopeConfig {
  const apiKey = readRequiredEnv("DASHSCOPE_API_KEY");
  const baseUrl = readRequiredEnv("DASHSCOPE_BASE_URL").replace(/\/+$/, "");

  return {
    apiKey,
    baseUrl,
  };
}

function buildTranscriptCacheKey(
  model: string,
  audioObjectKey: string,
  options: DashScopeAsrOptions,
): string {
  return `${model}:asr-v5:${sha256(JSON.stringify([audioObjectKey, options]))}`;
}

function assertDailyAsrQuotaAvailable(userId: string, nextDurationSeconds: number): void {
  const usedSeconds = readDailySucceededAsrDurationSeconds({ userId });
  if (usedSeconds + nextDurationSeconds > DAILY_TRANSCRIPTION_QUOTA_SECONDS) {
    throw new DailyAsrQuotaExceededError(nextAsrQuotaResetAt());
  }
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
    : { channel_id: [0] };

  if (options.diarizationEnabled) {
    if (options.profile !== "e2") {
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

  if (options.enableItn && options.profile === "e1") {
    normalized.enableItn = true;
  }

  if (options.diarizationEnabled && options.profile === "e2") {
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
  return options.profile === "e1"
    ? { file_url: fileUrl }
    : { file_urls: [fileUrl] };
}

export function getDashScopeAsrModelForProfile(profile: DashScopeAsrModelProfile): DashScopeAsrModel {
  const envName = profile === "e1" ? "DASHSCOPE_ASR_MODEL_E1" : "DASHSCOPE_ASR_MODEL_E2";
  return readRequiredEnv(envName);
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

function formatDashScopeTaskFailure(status: string, payload: unknown): string {
  const message =
    readStringPath(payload, ["output", "message"]) ||
    readStringPath(payload, ["output", "error_message"]) ||
    readStringPath(payload, ["data", "output_result", "output", "message"]) ||
    readStringPath(payload, ["data", "output_result", "output", "code"]) ||
    readStringField(payload, "message");
  return `DashScope ASR 任务${status === "FAILED" ? "失败" : "未完成"}${message ? `：${message}` : "。"}`;
}

function isConfigurationError(detail: string): boolean {
  return /未配置|认证失败|401|403/.test(detail);
}

function toProviderFailure(error: unknown): Extract<ProviderResult, { ok: false }> {
  const detail = error instanceof Error ? error.message : "转录文本失败。";
  return {
    ok: false,
    code: isConfigurationError(detail) ? "not_configured" : "error",
    detail,
  };
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 未配置。`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
