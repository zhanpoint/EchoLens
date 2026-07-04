import { createHash, randomUUID } from "node:crypto";
import type { ProviderResult } from "@/lib/ai/provider-result";
import { fetchWithRetry } from "@/lib/http/retry";
import type { UploadedAsrAudio } from "@/lib/oss/asr-audio";
import {
  TRANSCRIPT_POSTPROCESS_VERSION,
  streamQwenTranscriptPostprocess,
} from "@/lib/dashscope/transcript-postprocess";
import {
  insertAsrTask,
  markAsrTaskFailed,
  markAsrTaskRunning,
  markAsrTaskSucceeded,
  nextAsrQuotaResetAt,
  readAsrTask,
  readDailySucceededAsrDurationSeconds,
  readRunningAsrTask,
  readStoredTranscript,
  type StoredAsrTask,
  upsertStoredTranscript,
} from "@/lib/transcript/db";
import { stripTrailingDouyinWatermarkFromTranscript } from "@/lib/transcript/normalize";
import type { TranscriptSegment } from "@/types/douyin";

type DashScopeConfig = {
  apiKey: string;
  baseUrl: string;
  model: DashScopeAsrModel;
};

export type DashScopeAsrModel = "fun-asr" | "qwen3-asr-flash-filetrans";
export type DashScopeAsrModelProfile = "e1" | "e2";

export type DashScopeAsrOptions = {
  diarizationEnabled?: boolean;
  enableItn?: boolean;
  model?: DashScopeAsrModel;
  specialWordFilter?: DashScopeSpecialWordFilter;
  speakerCount?: number;
};

export type DashScopeAsrRuntimeOptions = {
  postprocess?: {
    enabled: boolean;
    onDelta?: (delta: string) => void;
  };
};

export type DashScopeSpecialWordFilter = {
  filter_with_empty?: DashScopeSensitiveWordList;
  filter_with_signed?: DashScopeSensitiveWordList;
  system_reserved_filter?: boolean;
};
export type DashScopeAsrAudio = UploadedAsrAudio & {
  durationSeconds: number;
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
  | { jobId: string; status: "running" }
  | { result: ProviderResult; status: "failed" | "succeeded" };

const QWEN_FILETRANS_MODEL: DashScopeAsrModel = "qwen3-asr-flash-filetrans";
const FUN_ASR_MODEL: DashScopeAsrModel = "fun-asr";
const DEFAULT_ASR_MODEL: DashScopeAsrModel = QWEN_FILETRANS_MODEL;
const SUPPORTED_ASR_MODELS = new Set<DashScopeAsrModel>(["fun-asr", QWEN_FILETRANS_MODEL]);
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
  options: DashScopeAsrOptions = {},
  runtimeOptions: DashScopeAsrRuntimeOptions = {},
): Promise<DashScopeAsrJobResult> {
  if (!audio?.signedUrl || !audio.objectKey || !Number.isFinite(audio.durationSeconds) || audio.durationSeconds <= 0) {
    return { status: "failed", result: { ok: false, code: "unavailable", detail: "原声音频缓存未就绪。" } };
  }

  try {
    const config = readDashScopeConfig();
    const normalizedOptions = normalizeDashScopeAsrOptions(options, config.model);
    const model = normalizedOptions.model;
    const cacheKey = buildTranscriptCacheKey(model, audio.objectKey, normalizedOptions);
    const stored = readStoredTranscript({ cacheKey, userId });
    if (stored) {
      return await storedTranscriptJobResult({
        cacheKey,
        model,
        runtimeOptions,
        transcript: stored,
        userId,
        workKey,
      });
    }

    const runningTask = readRunningAsrTask({ cacheKey, userId });
    if (runningTask) {
      return { status: "running", jobId: runningTask.id };
    }

    assertDailyAsrQuotaAvailable(userId, audio.durationSeconds);
    const taskId = await submitDashScopeAsrTask({ ...config, model }, audio.signedUrl, normalizedOptions);
    const jobId = randomUUID();
    insertAsrTask({
      audioDurationSeconds: audio.durationSeconds,
      cacheKey,
      id: jobId,
      model,
      objectKey: audio.objectKey,
      taskId,
      userId,
      workKey,
    });
    return { status: "running", jobId };
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
  options: DashScopeAsrOptions = {},
  runtimeOptions: DashScopeAsrRuntimeOptions = {},
): Promise<DashScopeAsrJobResult> {
  return await submitDashScopeAsrJob(userId, workKey, audio, options, runtimeOptions);
}

export function parseDashScopeTranscriptPayload(payload: unknown): TranscriptPayload | null {
  const transcripts = readArrayField(payload, "transcripts");
  if (transcripts) {
    const segments = transcripts.flatMap((transcript) => parseTranscriptSegments(transcript));
    const content = joinTranscriptText(
      transcripts
        .map((transcript) => readStringField(transcript, "text") || readStringField(transcript, "content"))
        .filter((text): text is string => Boolean(text)),
    ) || joinTranscriptText(segments.map((segment) => segment.text));

    return buildTranscriptPayload(content, segments);
  }

  const segments = parseTranscriptSegments(payload);
  const content = readStringField(payload, "text") ||
    readStringField(payload, "content") ||
    joinTranscriptText(segments.map((segment) => segment.text));

  return buildTranscriptPayload(content, segments);
}

function buildTranscriptPayload(content: string, segments: TranscriptSegment[]): TranscriptPayload | null {
  if (!content) {
    return null;
  }

  const emotions = readSegmentEmotions(segments);
  return {
    content,
    ...(emotions ? { emotions } : {}),
    ...(segments.length > 0 ? { transcriptSegments: segments } : {}),
  };
}

async function settleDashScopeAsrTask(
  job: StoredAsrTask,
  taskPayload: unknown,
  runtimeOptions: DashScopeAsrRuntimeOptions,
): Promise<DashScopeAsrJobResult> {
  const status = readTaskStatus(taskPayload);
  if (status === "SUCCEEDED") {
    const transcript = stripTrailingDouyinWatermarkFromTranscript(await readDashScopeTranscript(taskPayload));
    const model = parseDashScopeAsrModel(job.model) ?? DEFAULT_ASR_MODEL;
    const result = await postprocessTranscriptForStorage({
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
    upsertStoredTranscript({
      cacheKey: job.cacheKey,
      content: result.ok ? result.content : transcript.content,
      model,
      postprocessVersion: result.ok ? result.postprocessVersion : undefined,
      source: "dashscope",
      transcriptSegments: result.ok ? result.transcriptSegments : transcript.transcriptSegments,
      userId: job.userId,
      workKey: job.workKey,
    });
    markAsrTaskSucceeded(job.id);
    return result.ok ? { status: "succeeded", result } : { status: "failed", result };
  }

  if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
    const detail = formatDashScopeTaskFailure(status, taskPayload);
    markAsrTaskFailed(job.id, detail);
    return { status: "failed", result: { ok: false, code: "error", detail } };
  }

  markAsrTaskRunning(job.id);
  return { status: "running", jobId: job.id };
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
    return await readStoredAsrTaskResult(job, runtimeOptions);
  }

  const payload = await queryDashScopeAsrTask(job.taskId);
  return await settleDashScopeAsrTask(job, payload, runtimeOptions);
}

async function submitDashScopeAsrTask(
  config: DashScopeConfig,
  fileUrl: string,
  options: DashScopeAsrOptions,
): Promise<string> {
  const response = await dashScopeFetch(config, "/services/audio/asr/transcription", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dashscope-async": "enable",
    },
    body: JSON.stringify({
      model: config.model,
      input: buildDashScopeAsrInput(config.model, fileUrl),
      parameters: buildDashScopeAsrParameters(options, config.model),
    }),
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

async function queryDashScopeAsrTask(taskId: string): Promise<unknown> {
  const config = readDashScopeConfig();
  const response = await dashScopeFetch(config, `/tasks/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: {
      "content-type": "application/json",
    },
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(formatDashScopeError(response.status, payload));
  }

  return payload;
}

function readTaskStatus(payload: unknown): string {
  return readStringPath(payload, ["output", "task_status"]) ||
    readStringPath(payload, ["data", "task_status"]) ||
    readStringPath(payload, ["task_status"]) ||
    "";
}

async function readDashScopeTranscript(taskPayload: unknown): Promise<TranscriptPayload> {
  const resultUrls = findTranscriptionUrls(taskPayload);
  if (resultUrls.length === 0) {
    const inlineTranscript = parseDashScopeTranscriptPayload(taskPayload);
    if (inlineTranscript) {
      return inlineTranscript;
    }
    throw new Error("DashScope 未返回可下载的转录结果。");
  }

  const transcripts: TranscriptPayload[] = [];
  for (const url of resultUrls) {
    const response = await fetchWithRetry(url, {
      method: "GET",
      retry: {
        attempts: 2,
        timeoutMs: DASH_SCOPE_REQUEST_TIMEOUT_MS,
      },
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
  return {
    content,
    emotions: emotions.length > 0 ? emotions : undefined,
    transcriptSegments: transcriptSegments.length > 0 ? transcriptSegments : undefined,
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

async function readStoredAsrTaskResult(
  job: StoredAsrTask,
  runtimeOptions: DashScopeAsrRuntimeOptions,
): Promise<DashScopeAsrJobResult> {
  if (job.status === "succeeded") {
    const stored = readStoredTranscript({ cacheKey: job.cacheKey, userId: job.userId });
    return stored
      ? await storedTranscriptJobResult({
          cacheKey: job.cacheKey,
          model: parseDashScopeAsrModel(job.model) ?? DEFAULT_ASR_MODEL,
          runtimeOptions,
          transcript: stored,
          userId: job.userId,
          workKey: job.workKey,
        })
      : { status: "failed", result: { ok: false, code: "error", detail: "转录结果已过期，请重新提取。" } };
  }
  if (job.status === "failed") {
    return {
      status: "failed",
      result: { ok: false, code: "error", detail: job.errorDetail ?? "转录文本失败。" },
    };
  }

  return { status: "running", jobId: job.id };
}

async function storedTranscriptJobResult(input: {
  cacheKey: string;
  model: DashScopeAsrModel;
  runtimeOptions: DashScopeAsrRuntimeOptions;
  transcript: Extract<ProviderResult, { ok: true }>;
  userId: string;
  workKey: string;
}): Promise<DashScopeAsrJobResult> {
  const result = await postprocessTranscriptForStorage({
    model: input.model,
    runtimeOptions: input.runtimeOptions,
    transcript: input.transcript,
  });
  if (result.ok) {
    upsertStoredTranscript({
      cacheKey: input.cacheKey,
      content: result.content,
      model: input.model,
      postprocessVersion: result.postprocessVersion,
      source: "dashscope",
      transcriptSegments: result.transcriptSegments,
      userId: input.userId,
      workKey: input.workKey,
    });
    return { status: "succeeded", result };
  }

  return { status: "failed", result };
}

async function postprocessTranscriptForStorage(input: {
  model: DashScopeAsrModel;
  runtimeOptions: DashScopeAsrRuntimeOptions;
  transcript: Extract<ProviderResult, { ok: true }>;
}): Promise<ProviderResult> {
  if (!input.runtimeOptions.postprocess?.enabled ||
    input.transcript.postprocessVersion === TRANSCRIPT_POSTPROCESS_VERSION) {
    return {
      ...input.transcript,
      asrModel: input.transcript.asrModel ?? input.model,
    };
  }

  const result = await streamQwenTranscriptPostprocess({
    content: input.transcript.content,
    segments: input.transcript.transcriptSegments,
    onDelta: input.runtimeOptions.postprocess.onDelta ?? (() => undefined),
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
  const sentences = readArrayField(payload, "sentences");
  if (!sentences) {
    return [];
  }
  const speakerLabels = new Map<string, string>();

  return sentences
    .map((sentence): TranscriptSegment | null => {
      const text = readStringField(sentence, "text") || readStringField(sentence, "content");
      if (!text) {
        return null;
      }

      const emotion = readStringField(sentence, "emotion");
      return {
        endSeconds: readTimeField(sentence, ["end_time", "endTime", "end"]) ?? 0,
        ...(emotion ? { emotion } : {}),
        speakerId: readSpeakerId(sentence, speakerLabels) ?? undefined,
        startSeconds: readTimeField(sentence, ["begin_time", "beginTime", "start_time", "startTime", "start"]) ?? 0,
        text,
      };
    })
    .filter((segment): segment is TranscriptSegment => Boolean(segment));
}

function readSegmentEmotions(segments: TranscriptSegment[]): string[] | undefined {
  const emotions = [...new Set(segments.map((segment) => segment.emotion).filter((emotion): emotion is string => Boolean(emotion)))];
  return emotions.length > 0 ? emotions : undefined;
}

function findTranscriptionUrls(value: unknown): string[] {
  const officialUrls = [
    readStringPath(value, ["data", "output_result", "output", "result", "transcription_url"]),
    ...readTranscriptionUrlsFromResults(readArrayPath(value, ["data", "output_result", "output", "results"])),
    readStringPath(value, ["output", "result", "transcription_url"]),
    ...readTranscriptionUrlsFromResults(readArrayPath(value, ["output", "results"])),
  ].filter((url): url is string => Boolean(url));
  if (officialUrls.length > 0) {
    return [...new Set(officialUrls)];
  }

  const urls: string[] = [];
  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      if (/transcription_?url/i.test(key) && typeof child === "string" && child.startsWith("http")) {
        urls.push(child);
        continue;
      }
      visit(child);
    }
  }

  visit(value);
  return [...new Set(urls)];
}

function readArrayPath(value: unknown, path: string[]): unknown[] | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return Array.isArray(current) ? current : null;
}

function readTranscriptionUrlsFromResults(results: unknown[] | null): string[] {
  if (!results) {
    return [];
  }

  return results
    .map((result) => readStringField(result, "transcription_url"))
    .filter((url): url is string => Boolean(url));
}

function readDashScopeConfig(): DashScopeConfig {
  const apiKey = readRequiredEnv("DASHSCOPE_API_KEY");
  const baseUrl = readRequiredEnv("DASHSCOPE_BASE_URL").replace(/\/+$/, "");
  const model = getDashScopeAsrModelForProfile("e1");

  return {
    apiKey,
    baseUrl,
    model,
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

function readArrayField(value: unknown, field: string): unknown[] | null {
  return value && typeof value === "object" && Array.isArray((value as Record<string, unknown>)[field])
    ? ((value as Record<string, unknown>)[field] as unknown[])
    : null;
}

function readStringField(value: unknown, field: string): string | null {
  const fieldValue = value && typeof value === "object"
    ? (value as Record<string, unknown>)[field]
    : null;
  return typeof fieldValue === "string" && fieldValue.trim() ? fieldValue.trim() : null;
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

function readTimeField(value: unknown, fields: string[]): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const field of fields) {
    const rawValue = record[field];
    const parsed = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return field.endsWith("_time") || field.endsWith("Time") ? parsed / 1000 : parsed;
    }
  }

  return null;
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
  options: DashScopeAsrOptions = {},
  model: string = DEFAULT_ASR_MODEL,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = isQwenFiletransModel(model)
    ? {
        enable_words: false,
        ...(options.enableItn ? { enable_itn: true } : {}),
      }
    : { channel_id: [0] };

  if (options.diarizationEnabled) {
    if (!supportsDiarization(model)) {
      throw new Error(`当前 DashScope ASR 模型 ${model} 不支持说话人分离，请改用 Fun-ASR 模型。`);
    }
    parameters.diarization_enabled = true;
    if (options.speakerCount !== undefined) {
      parameters.speaker_count = options.speakerCount;
    }
  }

  if (options.specialWordFilter) {
    if (!supportsSpecialWordFilter(model)) {
      throw new Error(`当前 DashScope ASR 模型 ${model} 不支持敏感词过滤，请改用 Fun-ASR 或 Paraformer 模型。`);
    }
    parameters.special_word_filter = JSON.stringify(options.specialWordFilter);
  }

  return parameters;
}

function normalizeDashScopeAsrOptions(
  options: DashScopeAsrOptions,
  fallbackModel = DEFAULT_ASR_MODEL,
): Required<Pick<DashScopeAsrOptions, "model">> & Omit<DashScopeAsrOptions, "model"> {
  const model = options.model && SUPPORTED_ASR_MODELS.has(options.model) ? options.model : fallbackModel;
  const normalized: Required<Pick<DashScopeAsrOptions, "model">> & Omit<DashScopeAsrOptions, "model"> = { model };

  if (options.enableItn && isQwenFiletransModel(model)) {
    normalized.enableItn = true;
  }

  if (options.diarizationEnabled && supportsDiarization(model)) {
    normalized.diarizationEnabled = true;
    if (Number.isInteger(options.speakerCount)) {
      normalized.speakerCount = options.speakerCount;
    }
  }

  const specialWordFilter = normalizeSpecialWordFilter(options.specialWordFilter);
  if (specialWordFilter && supportsSpecialWordFilter(model)) {
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

function supportsSpecialWordFilter(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return normalizedModel.includes("fun-asr") || normalizedModel.includes("paraformer");
}

function supportsDiarization(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return normalizedModel.includes("fun-asr");
}

function isQwenFiletransModel(model: string): boolean {
  return model.trim().toLowerCase() === QWEN_FILETRANS_MODEL;
}

function buildDashScopeAsrInput(model: string, fileUrl: string): Record<string, unknown> {
  return isQwenFiletransModel(model)
    ? { file_url: fileUrl }
    : { file_urls: [fileUrl] };
}

function parseDashScopeAsrModel(value: string | undefined): DashScopeAsrModel | null {
  const model = value?.trim();
  if (!model) {
    return null;
  }

  return SUPPORTED_ASR_MODELS.has(model as DashScopeAsrModel)
    ? (model as DashScopeAsrModel)
    : null;
}

export function getDashScopeAsrModelForProfile(profile: DashScopeAsrModelProfile): DashScopeAsrModel {
  const envName = profile === "e1" ? "DASHSCOPE_ASR_MODEL_E1" : "DASHSCOPE_ASR_MODEL_E2";
  const fallback = profile === "e1" ? DEFAULT_ASR_MODEL : FUN_ASR_MODEL;
  return parseDashScopeAsrModel(process.env[envName]) ?? fallback;
}

function joinTranscriptText(parts: string[]): string {
  return parts
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .reduce((content, part) => {
      if (!content) {
        return part;
      }
      return `${content}${needsWordBoundary(content, part) ? " " : ""}${part}`;
    }, "");
}

function needsWordBoundary(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
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
