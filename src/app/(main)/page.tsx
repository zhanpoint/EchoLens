"use client";

import Image from "next/image";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  ArrowLeftRight,
  AudioLines,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Check,
  CornerUpLeft,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  GripVertical,
  History,
  Heart,
  Image as ImageIcon,
  Info,
  KeyRound,
  Languages,
  Link2,
  LogIn,
  LogOut,
  Loader2,
  MessageCircle,
  Pause,
  PencilLine,
  Pin,
  Play,
  Plus,
  Redo2,
  Save,
  Search,
  Settings,
  ShieldCheck,
  PanelLeft,
  Sparkles,
  Square,
  SquarePen,
  Star,
  Trash2,
  Undo2,
  UserRound,
  Volume2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  type Dispatch,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  TRANSCRIPT_FEATURE,
  getFeatureLabel,
  type DouyinKind,
  type ExtractionResult,
  type MediaAssetKind,
  type ResultFeature,
  type ResolvedDouyinWork,
  type TranscriptSegment,
} from "@/types/douyin";
import type { DouyinCommentsPayload } from "@/lib/douyin/comments";
import { SUMMARY_PROMPTS, type SummaryPrompt } from "@/lib/ai/prompts";
import { DEFAULT_DASHSCOPE_ASR_PROFILE } from "@/lib/dashscope/model-config";
import { clearProgressStartedAt, estimateMediaProcessingDurationSeconds, readProgressStartedAt } from "@/lib/douyin/cache-estimate";
import {
  mergeWorkMetadata,
  type WorkMetadataPatch,
} from "@/lib/douyin/client-metadata";
import {
  deleteClientSessionCache,
  readClientSessionCache,
  writeClientSessionCache,
} from "@/lib/transcript/client-session-cache";
import {
  cacheDownloadOrganization,
  saveToDownloadDirectory,
} from "@/lib/browser-download-directory";
import { isDownloadOrganization, type DownloadOrganization } from "@/lib/download-settings";
import {
  buildWorkKey,
  extractHttpUrl,
  mediaSourceFromWorkKey,
  type MediaSource,
} from "@/lib/media/source";
import { cn } from "@/lib/utils";
import { AsrQuotaIndicator, type AsrQuota } from "@/components/asr-quota-indicator";
import { InvitationDialog } from "@/components/invitation-dialog";
import { NetworkRetryButton } from "@/components/network-retry-button";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
} from "@/lib/http/retry";
import { applyStreamTextEvent } from "@/lib/http/retry-ui";

type ApiError = {
  error: string;
  code?: string;
  retryAfter?: number;
};

type ApiPayload = ApiError | Record<string, unknown>;
type PublicFeatures = {
  douyinAccountServicesEnabled: boolean;
  invitationRedeemed: boolean;
};
type SegmentTranslation = {
  error?: string;
  errorCode?: string;
  isLoading: boolean;
  text?: string;
};
type TranslationPair = {
  source: string;
  target: string;
};
type TranslationConfig = {
  domains: string;
  targetLang: string;
  termsText: string;
  tmText: string;
};
type TranslationUserSettings = TranslationConfig & {
  showSource: boolean;
};
type TranscriptUserSettings = {
  includeSpeakerEmotion: boolean;
  showSpeaker: boolean;
  showSpeakerEmotion: boolean;
};
type UserSettingsPayload = {
  settings?: {
    download?: { organization?: DownloadOrganization };
    transcript?: Partial<TranscriptUserSettings>;
    translation?: Partial<TranslationUserSettings>;
  };
};
type TranslationOptions = {
  domains?: string;
  source_lang: "auto";
  target_lang: string;
  terms?: TranslationPair[];
  tm_list?: TranslationPair[];
};
type TranslationTargetLanguageOption = {
  label: string;
  value: string;
};
type TranslationTargetRequest =
  | { kind: "all" }
  | { key: string; kind: "segment" | "subtitle" };
type TranslationStreamEvent =
  | { type: "segment_start"; key: string }
  | { type: "delta"; key: string; value: string }
  | { type: "replace"; key: string; value: "" }
  | { type: "segment_done"; key: string; value: string }
  | { type: "segment_error"; key: string; error: string; code?: string }
  | { type: "done" }
  | { type: "error"; error: string; code?: string };
type SummaryStreamEvent =
  | { type: "delta"; value: string }
  | { type: "replace"; value: "" }
  | { summary?: TranscriptHistorySummary; type: "done"; value: string }
  | { type: "error"; error: string; code?: string };
type CustomSummaryPrompt = SummaryPrompt & {
  createdAt: number;
  updatedAt: number;
};
type CustomSummaryPromptsPayload = ApiError | {
  prompts: CustomSummaryPrompt[];
};
type CustomSummaryPromptPayload = ApiError | {
  prompt: CustomSummaryPrompt;
};
type DeleteCustomSummaryPromptPayload = ApiError | {
  ok: true;
};
type TranscribeStreamEvent =
  | { type: "running"; jobId: string; status: "running"; work?: ResolvedDouyinWork }
  | { type: "postprocess_start"; work?: ResolvedDouyinWork }
  | { historyRecord?: TranscriptHistoryRecord; type: "done"; results: ExtractionResult[]; status: "successed"; work?: ResolvedDouyinWork }
  | { type: "error"; error: string; code?: string; retryAfter?: number; resetAt?: string; status: "canceled" | "failed"; work?: ResolvedDouyinWork };
type TranscribeStreamOutcome =
  | { type: "done" }
  | { type: "running"; jobId: string };
type LiveTranscribeSession = {
  input: string;
  isRunning: boolean;
  jobId: string;
  persisted: boolean;
  results: ExtractionResult[];
  statusMessage: string;
  work: ResolvedDouyinWork;
  workKey: string;
};
type DouyinWorkflowSession = {
  asrModel: AsrModelId;
  createdAt: number;
  sessionName: string;
  emptyFilterWords: string;
  error: string | null;
  errorCode?: string;
  historyRecordId: string;
  input: string;
  isResolving: boolean;
  isResultProcessing: boolean;
  lastResolvedInput: string;
  qwenAsrItnEnabled: boolean;
  results: ExtractionResult[];
  signedFilterWords: string;
  speakerCount: string;
  speakerDiarizationEnabled: boolean;
  specialWordFilterEnabled: boolean;
  specialWordFilterPanelOpen: boolean;
  systemReservedFilter: boolean;
  work: ResolvedDouyinWork | null;
};
type SidebarEntry = {
  hasRecord: boolean;
  id: string;
  isBusy: boolean;
  isPinned: boolean;
  isSession: boolean;
  sortAt: number;
  source: MediaSource;
  statusMessage: string;
  title: string;
};
type CurrentWorkflowSnapshot = {
  activeHistoryDetail?: TranscriptHistoryDetail;
  activeHistoryRecordId: string;
  activeView?: {
    id: string;
    kind: "history" | "workflow";
  };
  liveHistorySummariesByRecordId: Record<string, TranscriptHistorySummary[]>;
  liveTranscribeSessions: Record<string, LiveTranscribeSession>;
  sessions: Record<string, DouyinWorkflowSession>;
  userId: string;
};
type CurrentUser = {
  email: string;
  id: string;
  role?: "admin" | "user";
  username: string;
};
type ClientCacheAsset = "avatar" | MediaAssetKind;
type CachedMediaAsset = {
  downloadName: string;
  error?: string;
  errorCode?: string;
  isLoading: boolean;
  objectKey?: string;
  url?: string;
  verified?: boolean;
  workKey: string;
};
const BILIBILI_VIDEO_CACHE_MISSING_CODE = "BILIBILI_VIDEO_CACHE_MISSING";
const assetCacheMemory = new Map<string, Partial<Record<ClientCacheAsset, CachedMediaAsset>>>();

type TranscriptHistoryRecord = {
  authorName?: string;
  authorUrl?: string;
  caption: string;
  createdAt: number;
  sessionName: string;
  durationSeconds?: number;
  finalUrl: string;
  id: string;
  inputUrl: string;
  pinnedAt?: number;
  transcriptContent: string;
  transcriptSegments?: TranscriptSegment[];
  updatedAt: number;
  userId?: string;
  workId: string;
  workKey: string;
  workKind: DouyinKind;
};
type TranscriptHistorySummary = {
  content: string;
  createdAt: number;
  id: string;
  promptId: string;
  promptTitle: string;
};
type TranscriptHistoryDetail = {
  record: TranscriptHistoryRecord;
  summaries: TranscriptHistorySummary[];
};

type ClipboardMediaInput = {
  tags: string[];
  text: string;
  url: string;
};

type SpeakerOption = {
  id: string;
  label: string;
};
type AsrModelId = "e1" | "e2" | "e3";
type AsrModelOption = {
  description: string;
  id: AsrModelId;
  label: string;
};

type SpeakerEditorTarget = {
  segmentKey: string;
  speakerId?: string;
};
type SpecialWordFilterRequest = {
  filter_with_empty?: {
    word_list: string[];
  };
  filter_with_signed?: {
    word_list: string[];
  };
  system_reserved_filter: boolean;
};
type SubtitleCue = {
  endSeconds: number;
  emotion?: string;
  startSeconds: number;
  text: string;
};
type TranscriptDownloadFormat = "json" | "md" | "srt" | "txt" | "vtt";
type TextTranscriptDownloadFormat = Exclude<TranscriptDownloadFormat, "srt" | "vtt">;
type TranscriptViewMode = "subtitles" | "transcript";
type EditHistory = {
  future: string[][];
  past: string[][];
};

class AuthRequiredError extends Error {
  constructor() {
    super("请先登录后再使用。");
  }
}

function isAuthRequiredError(error: unknown): error is AuthRequiredError {
  return error instanceof AuthRequiredError;
}

function isUnauthenticatedApiResponse(response: Response, payload: unknown): boolean {
  return (
    response.status === 401 &&
    Boolean(payload && typeof payload === "object" && "code" in payload && payload.code === "UNAUTHENTICATED")
  );
}

function getApiError(payload: unknown): ApiError | undefined {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return undefined;
  }
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "string") {
    return undefined;
  }
  const code = (payload as { code?: unknown }).code;
  const retryAfter = (payload as { retryAfter?: unknown }).retryAfter;
  return {
    error,
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof retryAfter === "number" ? { retryAfter } : {}),
  };
}

function isResolvedWorkPayload(payload: unknown): payload is
  | { sameAsCurrent: true }
  | { work: ResolvedDouyinWork } {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  if ((payload as { sameAsCurrent?: unknown }).sameAsCurrent === true) {
    return true;
  }
  const workValue = (payload as { work?: unknown }).work;
  if (!workValue || typeof workValue !== "object") {
    return false;
  }
  const work = workValue as Partial<ResolvedDouyinWork>;
  return typeof work.caption === "string" && work.caption.trim().length > 0 &&
    typeof work.finalUrl === "string" &&
    typeof work.id === "string" &&
    typeof work.inputUrl === "string" &&
    work.kind === "video" &&
    (work.source === undefined || work.source === "douyin" || work.source === "bilibili");
}

function getAvatarInitial(user: CurrentUser): string {
  const source = (user.username || user.email).trim();
  const initial = Array.from(source)[0] ?? "?";
  return /^[a-z]$/i.test(initial) ? initial.toLocaleUpperCase("en-US") : initial;
}

function formatFriendlyDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}年${values.month}月${values.day}日 ${values.hour}:${values.minute}`;
}

async function readApiPayload(response: Response, fallback: string): Promise<ApiPayload> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("json")) {
    throw new Error(formatHttpError(response.status, fallback));
  }

  try {
    return JSON.parse(text) as ApiPayload;
  } catch {
    throw new Error("服务响应异常，请稍后重试。");
  }
}

function formatHttpError(status: number, fallback: string): string {
  if (status === 401) {
    return "请先登录后再使用。";
  }
  if (status === 403) {
    return "当前账号没有权限执行此操作。";
  }
  if (status === 404) {
    return "请求的资源不存在，请刷新后重试。";
  }
  if (status === 408 || status === 504) {
    return "请求超时，请稍后重试。";
  }
  if (status === 429) {
    return "请求过于频繁，请稍后重试。";
  }
  if (status >= 500) {
    return "服务暂时不可用，请稍后重试。";
  }

  return fallback;
}

function buildTranslationOptions(
  config: TranslationConfig,
  targetLangOverride?: string,
): { ok: true; value: TranslationOptions } | { ok: false; error: string } {
  const targetLang = targetLangOverride?.trim() || config.targetLang.trim();
  if (!targetLang) {
    return { ok: false, error: "请先选择目标语言。" };
  }

  const terms = parseTranslationPairs(config.termsText);
  const tmList = parseTranslationPairs(config.tmText);
  const domains = config.domains.trim();

  if (terms.error) {
    return { ok: false, error: `术语表第 ${terms.error.line} 行格式无效，请使用“源文 => 译文”。` };
  }
  if (tmList.error) {
    return { ok: false, error: `翻译记忆第 ${tmList.error.line} 行格式无效，请使用“源文 => 译文”。` };
  }
  if (domains && /[^\u0000-\u007f]/u.test(domains)) {
    return { ok: false, error: "领域提示当前只支持英文，请改为英文描述。" };
  }

  return {
    ok: true,
    value: {
      source_lang: "auto",
      target_lang: targetLang,
      ...(domains ? { domains } : {}),
      ...(terms.pairs.length ? { terms: terms.pairs } : {}),
      ...(tmList.pairs.length ? { tm_list: tmList.pairs } : {}),
    },
  };
}

function normalizeTranslationUserSettings(value: Partial<TranslationUserSettings> | undefined): TranslationUserSettings {
  return {
    ...DEFAULT_TRANSLATION_CONFIG,
    domains: typeof value?.domains === "string" ? value.domains : DEFAULT_TRANSLATION_CONFIG.domains,
    showSource: typeof value?.showSource === "boolean" ? value.showSource : true,
    targetLang: typeof value?.targetLang === "string" ? value.targetLang : DEFAULT_TRANSLATION_CONFIG.targetLang,
    termsText: typeof value?.termsText === "string" ? value.termsText : DEFAULT_TRANSLATION_CONFIG.termsText,
    tmText: typeof value?.tmText === "string" ? value.tmText : DEFAULT_TRANSLATION_CONFIG.tmText,
  };
}

function normalizeTranscriptUserSettings(value: Partial<TranscriptUserSettings> | undefined): TranscriptUserSettings {
  return {
    includeSpeakerEmotion: typeof value?.includeSpeakerEmotion === "boolean" ? value.includeSpeakerEmotion : false,
    showSpeaker: typeof value?.showSpeaker === "boolean" ? value.showSpeaker : true,
    showSpeakerEmotion: typeof value?.showSpeakerEmotion === "boolean" ? value.showSpeakerEmotion : false,
  };
}

async function saveUserSetting(category: "transcript" | "translation", value: unknown): Promise<void> {
  const response = await fetch("/api/user/settings", {
    body: JSON.stringify({ category, value }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });

  if (!response.ok) {
    const payload = await readApiPayload(response, "设置保存失败。");
    throw new Error(getApiError(payload)?.error || "设置保存失败。");
  }
}

function parseTranslationPairs(value: string): {
  error?: { line: number };
  pairs: TranslationPair[];
} {
  const pairs: TranslationPair[] = [];
  const lines = value.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    const separator = line.includes("=>") ? "=>" : line.includes("->") ? "->" : "";
    if (!separator) {
      return { error: { line: index + 1 }, pairs: [] };
    }

    const [source, ...targetParts] = line.split(separator);
    const target = targetParts.join(separator);
    if (!source.trim() || !target.trim()) {
      return { error: { line: index + 1 }, pairs: [] };
    }

    pairs.push({
      source: source.trim(),
      target: target.trim(),
    });
  }

  return { pairs };
}

function readUserFacingError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  if (readUserFacingErrorCode(error) === NETWORK_RETRY_ERROR_CODE) {
    return NETWORK_RETRY_ERROR_MESSAGE;
  }
  const message = error.message.trim();
  if (error.name === "AbortError") {
    return "请求已取消。";
  }

  return message || fallback;
}

function readUserFacingErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string") return code;
  return /^(Failed to fetch|NetworkError|Load failed|fetch failed)$/i.test(error.message.trim())
    ? NETWORK_RETRY_ERROR_CODE
    : undefined;
}

function codedError(message: string, code?: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function throwApiError(payload: ApiError | undefined, fallback: string): never {
  throw codedError(payload?.error || fallback, payload?.code);
}

async function streamTranslationContent(input: {
  items: Array<{ key: string; text: string }>;
  onDelta: (key: string, delta: string) => void;
  onReplace: (key: string) => void;
  onDone: (key: string, text: string) => void;
  onError: (key: string, error: string, code?: string) => void;
  options: TranslationOptions;
}): Promise<void> {
  const response = await fetch("/api/douyin/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      texts: input.items,
      translation_options: input.options,
    }),
  });
  if (!response.ok || !response.body) {
    const payload = await readApiPayload(response, "翻译失败。");
    if (isUnauthenticatedApiResponse(response, payload)) {
      throw new AuthRequiredError();
    }
    throwApiError(getApiError(payload), "翻译失败。");
  }

  for await (const event of readJsonEventStream<TranslationStreamEvent>(response.body)) {
    if (event.type === "delta") {
      input.onDelta(event.key, event.value);
    } else if (event.type === "replace") {
      input.onReplace(event.key);
    } else if (event.type === "segment_done") {
      input.onDone(event.key, event.value);
    } else if (event.type === "segment_error") {
      input.onError(event.key, event.error, event.code);
    } else if (event.type === "error") {
      throw codedError(event.error, event.code);
    }
  }
}

async function streamSummaryContent(input: {
  historyRecordId?: string;
  onDelta: (delta: string) => void;
  onReplace: () => void;
  onDone: (text: string, summary?: TranscriptHistorySummary) => void;
  prompt: string;
  promptId: string;
  promptTitle: string;
  signal?: AbortSignal;
  text: string;
}): Promise<void> {
  const response = await fetch("/api/douyin/summarize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      historyRecordId: input.historyRecordId,
      prompt: input.prompt,
      promptId: input.promptId,
      promptTitle: input.promptTitle,
      text: input.text,
    }),
    signal: input.signal,
  });

  if (!response.ok || !response.body) {
    const payload = await readApiPayload(response, "AI处理失败。");
    if (isUnauthenticatedApiResponse(response, payload)) {
      throw new AuthRequiredError();
    }
    throwApiError(getApiError(payload), "AI处理失败。");
  }

  for await (const event of readJsonEventStream<SummaryStreamEvent>(response.body)) {
    if (event.type === "delta") {
      input.onDelta(event.value);
    } else if (event.type === "replace") {
      input.onReplace();
    } else if (event.type === "done") {
      input.onDone(event.value, event.summary);
    } else if (event.type === "error") {
      throw codedError(event.error, event.code);
    }
  }
}

async function fetchCustomSummaryPrompts(): Promise<CustomSummaryPrompt[]> {
  const response = await fetch("/api/transcript-prompts", { cache: "no-store" });
  const payload = await readApiPayload(response, "自定义提示词加载失败。") as CustomSummaryPromptsPayload;
  if (!response.ok) {
    if (isUnauthenticatedApiResponse(response, payload)) {
      throw new AuthRequiredError();
    }
    throw new Error(getApiError(payload)?.error || "自定义提示词加载失败。");
  }
  return "prompts" in payload ? payload.prompts : [];
}

async function createCustomSummaryPrompt(input: {
  prompt: string;
  title: string;
}): Promise<CustomSummaryPrompt> {
  const response = await fetch("/api/transcript-prompts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await readApiPayload(response, "自定义提示词保存失败。") as CustomSummaryPromptPayload;
  if (!response.ok) {
    if (isUnauthenticatedApiResponse(response, payload)) {
      throw new AuthRequiredError();
    }
    throw new Error(getApiError(payload)?.error || "自定义提示词保存失败。");
  }
  if (!("prompt" in payload)) {
    throw new Error("自定义提示词保存失败。");
  }
  return payload.prompt;
}

async function updateCustomSummaryPrompt(input: {
  id: string;
  prompt: string;
  title: string;
}): Promise<CustomSummaryPrompt> {
  const response = await fetch(`/api/transcript-prompts/${encodeURIComponent(input.id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: input.prompt,
      title: input.title,
    }),
  });
  const payload = await readApiPayload(response, "自定义提示词更新失败。") as CustomSummaryPromptPayload;
  if (!response.ok) {
    if (isUnauthenticatedApiResponse(response, payload)) {
      throw new AuthRequiredError();
    }
    throw new Error(getApiError(payload)?.error || "自定义提示词更新失败。");
  }
  if (!("prompt" in payload)) {
    throw new Error("自定义提示词更新失败。");
  }
  return payload.prompt;
}

async function deleteCustomSummaryPrompt(id: string): Promise<void> {
  const response = await fetch(`/api/transcript-prompts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const payload = await readApiPayload(response, "自定义提示词删除失败。") as DeleteCustomSummaryPromptPayload;
  if (!response.ok) {
    if (isUnauthenticatedApiResponse(response, payload)) {
      throw new AuthRequiredError();
    }
    throw new Error(getApiError(payload)?.error || "自定义提示词删除失败。");
  }
}

async function fetchTranscriptHistoryList(query = ""): Promise<TranscriptHistoryRecord[]> {
  const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
  const response = await fetch(`/api/transcript-history${params}`, { cache: "no-store" });
  const payload = await readApiPayload(response, "转录历史加载失败。") as ApiError | { records: TranscriptHistoryRecord[] };
  if (!response.ok) {
    if (isUnauthenticatedApiResponse(response, payload)) {
      throw new AuthRequiredError();
    }
    throw new Error(getApiError(payload)?.error || "转录历史加载失败。");
  }
  return "records" in payload ? payload.records : [];
}

const TRANSCRIPT_HISTORY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const HISTORY_LIST_CACHE_KEY = "history-list";
const WORKFLOW_CACHE_KEY = "current-workflow";

type TranscriptHistoryCache = {
  records: TranscriptHistoryRecord[];
  refreshedAt: number;
};

function updateTranscriptHistoryCache(
  userId: string,
  update: (records: TranscriptHistoryRecord[]) => TranscriptHistoryRecord[],
): void {
  void readClientSessionCache<TranscriptHistoryCache>(userId, HISTORY_LIST_CACHE_KEY)
    .then((cached) => cached
      ? writeClientSessionCache(userId, HISTORY_LIST_CACHE_KEY, {
          records: update(cached.records),
          refreshedAt: Date.now(),
        } satisfies TranscriptHistoryCache)
      : undefined)
    .catch(() => undefined);
}

async function fetchTranscriptHistoryDetail(id: string): Promise<TranscriptHistoryDetail> {
  const response = await fetch(`/api/transcript-history/${encodeURIComponent(id)}`, { cache: "no-store" });
  const payload = await readApiPayload(response, "转录历史加载失败。") as ApiError | TranscriptHistoryDetail;
  if (!response.ok) {
    if (isUnauthenticatedApiResponse(response, payload)) {
      throw new AuthRequiredError();
    }
    throw new Error(getApiError(payload)?.error || "转录历史加载失败。");
  }
  return payload as TranscriptHistoryDetail;
}

async function renameTranscriptHistory(id: string, sessionName: string): Promise<TranscriptHistoryRecord> {
  const response = await fetch(`/api/transcript-history/${encodeURIComponent(id)}`, {
    body: JSON.stringify({ sessionName }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const payload = await readApiPayload(response, "历史记录名称保存失败。") as ApiError | { record: TranscriptHistoryRecord };
  if (!response.ok) {
    throw new Error(getApiError(payload)?.error || "历史记录名称保存失败。");
  }
  return "record" in payload ? payload.record : Promise.reject(new Error("历史记录名称保存失败。"));
}

async function setTranscriptHistoryPinned(id: string, pinned: boolean): Promise<TranscriptHistoryRecord> {
  const response = await fetch(`/api/transcript-history/${encodeURIComponent(id)}`, {
    body: JSON.stringify({ pinned }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const payload = await readApiPayload(response, "会话置顶状态保存失败。") as ApiError | { record: TranscriptHistoryRecord };
  if (!response.ok) {
    throw new Error(getApiError(payload)?.error || "会话置顶状态保存失败。");
  }
  return "record" in payload ? payload.record : Promise.reject(new Error("会话置顶状态保存失败。"));
}

async function updateTranscriptHistoryTranscript(input: {
  id: string;
  transcriptContent: string;
  transcriptSegments: TranscriptSegment[];
}): Promise<TranscriptHistoryRecord> {
  const response = await fetch(`/api/transcript-history/${encodeURIComponent(input.id)}`, {
    body: JSON.stringify({
      transcriptContent: input.transcriptContent,
      transcriptSegments: input.transcriptSegments,
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const payload = await readApiPayload(response, "转录文本保存失败。") as ApiError | { record: TranscriptHistoryRecord };
  if (!response.ok) {
    if (isUnauthenticatedApiResponse(response, payload)) {
      throw new AuthRequiredError();
    }
    throw new Error(getApiError(payload)?.error || "转录文本保存失败。");
  }
  return "record" in payload ? payload.record : Promise.reject(new Error("转录文本保存失败。"));
}

async function deleteTranscriptHistory(id: string): Promise<void> {
  const response = await fetch(`/api/transcript-history?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) {
    const payload = await readApiPayload(response, "历史记录删除失败。") as ApiError;
    throw new Error(payload.error || "历史记录删除失败。");
  }
}

async function deleteTranscriptHistorySummary(recordId: string, summaryId: string): Promise<void> {
  const response = await fetch(
    `/api/transcript-history/${encodeURIComponent(recordId)}/summaries?summaryId=${encodeURIComponent(summaryId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const payload = await readApiPayload(response, "总结记录删除失败。") as ApiError;
    if (isUnauthenticatedApiResponse(response, payload)) {
      throw new AuthRequiredError();
    }
    throw new Error(getApiError(payload)?.error || "总结记录删除失败。");
  }
}

async function cancelTranscribeJob(jobId: string): Promise<void> {
  if (!jobId) {
    return;
  }
  await fetch(`/api/douyin/transcribe?jobId=${encodeURIComponent(jobId)}`, {
    cache: "no-store",
    method: "DELETE",
  }).catch(() => undefined);
}

async function* readJsonEventStream<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/u);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const parsed = parseJsonEvent<T>(event);
        if (parsed) {
          yield parsed;
        }
      }
    }

    buffer += decoder.decode();
    const parsed = parseJsonEvent<T>(buffer);
    if (parsed) {
      yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseJsonEvent<T>(event: string): T | null {
  const data = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) {
    return null;
  }

  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

async function readClipboardMediaInput(): Promise<ClipboardMediaInput | null> {
  if (typeof window === "undefined" || !window.isSecureContext || !navigator.clipboard?.readText) {
    return null;
  }

  try {
    const value = (await navigator.clipboard.readText()).trim();
    const mediaInput = extractMediaInput(value);
    return value.length <= CLIPBOARD_INPUT_LIMIT && mediaInput
      ? { text: value, ...mediaInput }
      : null;
  } catch {
    return null;
  }
}

function isSameMediaInput(current: string, next: ClipboardMediaInput): boolean {
  const currentInput = extractMediaInput(current);
  if (!currentInput) {
    return false;
  }

  return currentInput.url === next.url || areSameTags(currentInput.tags, next.tags);
}

function extractMediaInput(value: string): Pick<ClipboardMediaInput, "tags" | "url"> | null {
  const extracted = extractHttpUrl(value);
  if (!extracted) return null;

  return {
    tags: extractTagsBeforeUrl(value, extracted.index),
    url: extracted.value,
  };
}

function extractTagsBeforeUrl(value: string, urlIndex: number): string[] {
  const tags = value
    .slice(0, urlIndex)
    .match(TAG_PATTERN)
    ?.map((tag) => tag.replace(/^#\s*/u, "").trim().toLocaleLowerCase())
    .filter(Boolean);

  return [...new Set(tags ?? [])].sort();
}

function areSameTags(currentTags: string[], nextTags: string[]): boolean {
  return (
    currentTags.length > 0 &&
    currentTags.length === nextTags.length &&
    currentTags.every((tag, index) => tag === nextTags[index])
  );
}

const KIND_LABELS: Record<DouyinKind, string> = {
  video: "视频",
};
const SOURCE_LABELS: Record<MediaSource, string> = {
  bilibili: "Bilibili",
  douyin: "抖音",
};

const DOWNLOAD_ACTIONS: Array<{
  asset: MediaAssetKind;
  icon: typeof Download;
  label: string;
  previewLabel: string;
}> = [
  { asset: "cover", icon: ImageIcon, label: "下载封面", previewLabel: "预览封面" },
  { asset: "video", icon: Play, label: "下载视频", previewLabel: "观看视频" },
  { asset: "originalAudio", icon: AudioLines, label: "下载原声", previewLabel: "试听原声" },
];

const CLIPBOARD_PRIVACY_HINT = "自动粘贴功能：检测到剪贴板最新记录包含 HTTP/HTTPS 视频分享链接会自动填入输入框，但不会读取粘贴板历史记录，保护您的隐私。";
const TAG_PATTERN = /#\s*[\p{L}\p{N}_-]+/gu;
const SOCIAL_TOKEN_PATTERN = /([#@][\p{L}\p{N}_-]+)/gu;
const CLIPBOARD_INPUT_LIMIT = 5000;
const USAGE_CONSENT_EVENT = "echolens:usage-consent";
const USAGE_CONSENT_STORAGE_KEY = "echolens:usage-consent";
function subscribeUsageConsent(onStoreChange: () => void): () => void {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(USAGE_CONSENT_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(USAGE_CONSENT_EVENT, onStoreChange);
  };
}

function readUsageConsent(): boolean {
  return window.localStorage.getItem(USAGE_CONSENT_STORAGE_KEY) === "true";
}

function readServerUsageConsent(): boolean {
  return false;
}

function isCanonicalWorkflowSnapshot(snapshot: CurrentWorkflowSnapshot): boolean {
  const sessions = Object.entries(snapshot.sessions);
  const activeViewIsValid = snapshot.activeView === undefined
    || (snapshot.activeView.kind === "workflow"
      ? snapshot.activeView.id === snapshot.activeHistoryRecordId
      : snapshot.activeView.id === snapshot.activeHistoryDetail?.record.id);
  return sessions.length > 0 &&
    Boolean(snapshot.sessions[snapshot.activeHistoryRecordId]) &&
    activeViewIsValid &&
    sessions.every(([id, session]) => id === session.historyRecordId) &&
    Object.keys(snapshot.liveTranscribeSessions).every((id) => Boolean(snapshot.sessions[id]));
}

async function readCurrentWorkflow(userId: string): Promise<CurrentWorkflowSnapshot | null> {
  return await readClientSessionCache<CurrentWorkflowSnapshot>(userId, WORKFLOW_CACHE_KEY).catch(() => null);
}

function writeCurrentWorkflow(snapshot: CurrentWorkflowSnapshot): void {
  void writeClientSessionCache(snapshot.userId, WORKFLOW_CACHE_KEY, snapshot).catch(() => undefined);
}

function clearCurrentWorkflow(userId: string): void {
  void deleteClientSessionCache(userId, WORKFLOW_CACHE_KEY).catch(() => undefined);
}
const SPEAKER_COUNT_MIN = 1;
const SPEAKER_COUNT_MAX = 10;
const SUBTITLE_MAX_CHARS_PER_CUE = 84;
const SUBTITLE_MAX_LINE_LENGTH = 42;
const ASR_MODEL_PANEL_WIDTH = 220;
const TRANSCRIBE_POLL_INTERVAL_MS = 1_000;
const TRANSCRIBE_POLL_TIMEOUT_MS = 10 * 60_000;
const RESULT_PANEL_BODY_CLASS = "content-scroll h-[min(65dvh,36rem)] min-h-[20rem] overflow-auto sm:h-[36rem]";
const RESULT_SPLIT_STORAGE_KEY = "echolens:result-split-ratio";
const RESULT_SPLIT_DEFAULT_RATIO = 55;
const RESULT_SPLIT_MIN_RATIO = 32;
const RESULT_SPLIT_MAX_RATIO = 68;
const RESULT_SPLIT_KEYBOARD_STEP = 2;
const RESULT_SPLITTER_WIDTH = 12;
const DEFAULT_TRANSLATION_CONFIG: TranslationConfig = {
  domains: "",
  targetLang: "",
  termsText: "",
  tmText: "",
};
const TRANSLATION_TARGET_LANG_OPTIONS: TranslationTargetLanguageOption[] = [
  { label: "English", value: "English" },
  { label: "简体中文", value: "Chinese" },
  { label: "हिन्दी", value: "Hindi" },
  { label: "Español", value: "Spanish" },
  { label: "العربية", value: "Arabic" },
  { label: "Français", value: "French" },
  { label: "বাংলা", value: "Bengali" },
  { label: "Português", value: "Portuguese" },
  { label: "Русский", value: "Russian" },
  { label: "اردو", value: "Urdu" },
  { label: "Bahasa Indonesia", value: "Indonesian" },
  { label: "Deutsch", value: "German" },
  { label: "日本語", value: "Japanese" },
  { label: "한국어", value: "Korean" },
  { label: "Italiano", value: "Italian" },
  { label: "Tiếng Việt", value: "Vietnamese" },
  { label: "Türkçe", value: "Turkish" },
  { label: "ไทย", value: "Thai" },
];
const TRANSLATION_SETTING_HELP: Record<"domains" | "terms" | "tm", string> = {
  domains:
    "若需要译文风格符合特定领域（如法律文书要求严肃正式，社交内容要求口语化），可通过 translation_options 参数传入领域提示语句。",
  terms:
    "当文本包含品牌名、产品名或专业术语时，为保证翻译的准确性和一致性，可通过 terms 字段提供一个术语表，引导模型参考术语表进行翻译。",
  tm:
    "需要模型遵循特定翻译风格或句式时，可通过 tm_list 字段提供“源文-译文”句对作为参考。模型将在当次翻译任务中模仿这些示例的风格，适合维护大型文档集的术语一致性，或沿用企业已有的写作规范。",
};
const ASR_MODEL_OPTIONS: AsrModelOption[] = [
  {
    description: "适合多语言、背景噪声、音乐/说唱、远场和混叠语音等复杂通用场景。",
    id: "e1",
    label: "E1模型",
  },
  {
    description: "适合中文、方言、古诗词、正式文本和需要说话人分离或敏感词过滤的场景。",
    id: "e2",
    label: "E2模型",
  },
  {
    description: "全球第一的最强大的中文ASR模型，支持说话人分离和情感识别。",
    id: "e3",
    label: "E3模型",
  },
];

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function createClientJobId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createWorkflowSessionId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function createWorkflowSession(historyRecordId = createWorkflowSessionId()): DouyinWorkflowSession {
  return {
    asrModel: DEFAULT_DASHSCOPE_ASR_PROFILE,
    createdAt: Date.now(),
    sessionName: "",
    emptyFilterWords: "",
    error: null,
    historyRecordId,
    input: "",
    isResolving: false,
    isResultProcessing: false,
    lastResolvedInput: "",
    qwenAsrItnEnabled: false,
    results: [],
    signedFilterWords: "",
    speakerCount: "",
    speakerDiarizationEnabled: false,
    specialWordFilterEnabled: false,
    specialWordFilterPanelOpen: false,
    systemReservedFilter: true,
    work: null,
  };
}

function mergeHistoryDetailIntoWorkflowSession(
  detail: TranscriptHistoryDetail,
  session = createWorkflowSession(detail.record.id),
): DouyinWorkflowSession {
  const record = detail.record;
  return {
    ...session,
    input: record.inputUrl,
    lastResolvedInput: record.inputUrl,
    results: [historyRecordToResult(record)],
    work: historyRecordToWork(record),
  };
}

function getPostprocessStatusMessage(): string {
  return "正在优化转录结果...";
}

function historyRecordToWork(record: TranscriptHistoryRecord): ResolvedDouyinWork {
  return {
    authorName: record.authorName,
    authorUrl: record.authorUrl,
    caption: record.caption,
    durationSeconds: record.durationSeconds,
    finalUrl: record.finalUrl,
    id: record.workId,
    inputUrl: record.inputUrl,
    kind: record.workKind,
    source: mediaSourceFromWorkKey(record.workKey),
  };
}

function historyRecordToResult(record: TranscriptHistoryRecord): ExtractionResult {
  return {
    feature: TRANSCRIPT_FEATURE,
    label: getFeatureLabel(TRANSCRIPT_FEATURE),
    status: "success",
    source: "dashscope",
    content: record.transcriptContent,
    transcriptSegments: record.transcriptSegments,
  };
}

function getWorkKey(work: Pick<ResolvedDouyinWork, "id" | "kind" | "source">): string {
  return buildWorkKey(work);
}

function getWorkflowSessionStatus(
  session: DouyinWorkflowSession,
  liveSession: LiveTranscribeSession | undefined,
  isCaching: boolean,
): Pick<SidebarEntry, "isBusy" | "statusMessage"> {
  if (session.isResolving) {
    return { isBusy: true, statusMessage: "正在检测作品链接" };
  }
  if (isCaching) {
    return { isBusy: true, statusMessage: "正在缓存作品资源" };
  }
  if (liveSession?.isRunning) {
    return { isBusy: true, statusMessage: liveSession.statusMessage || "正在转录" };
  }
  if (session.isResultProcessing) {
    return { isBusy: true, statusMessage: "正在生成翻译或 AI 总结" };
  }
  return { isBusy: false, statusMessage: "等待继续处理" };
}

/**
 * 会话列表的唯一真相：持久化记录与内存工作会话按 id 合并去重。
 * 排序键取记录的 updatedAt，打开会话不会改写它，因此切换会话不会打乱顺序。
 */
function buildSidebarEntries(input: {
  historyRecords: TranscriptHistoryRecord[];
  liveTranscribeSessions: Record<string, LiveTranscribeSession>;
  loadingWorkKeys: ReadonlySet<string>;
  workflowSessions: Record<string, DouyinWorkflowSession>;
}): SidebarEntry[] {
  const recordById = new Map(input.historyRecords.map((record) => [record.id, record]));
  const ids = new Set([...recordById.keys(), ...Object.keys(input.workflowSessions)]);

  return [...ids].flatMap((id) => {
    const record = recordById.get(id);
    const session = input.workflowSessions[id];
    if (!record && !(session?.input || session?.work || session?.results.length)) return [];

    const workKey = session?.work ? getWorkKey(session.work) : "";
    const status = session
      ? getWorkflowSessionStatus(
          session,
          input.liveTranscribeSessions[id],
          Boolean(workKey && input.loadingWorkKeys.has(workKey)),
        )
      : { isBusy: false, statusMessage: "" };

    return [{
      hasRecord: Boolean(record),
      id,
      isBusy: status.isBusy,
      isPinned: record?.pinnedAt !== undefined,
      isSession: Boolean(session),
      sortAt: record?.updatedAt ?? session?.createdAt ?? 0,
      source: session?.work?.source ?? mediaSourceFromWorkKey(record?.workKey),
      statusMessage: status.statusMessage,
      title: session?.sessionName.trim()
        || session?.work?.caption?.trim()
        || record?.sessionName
        || "未命名会话",
    }];
  }).sort((first, second) => second.sortAt - first.sortAt);
}

function resolveStateAction<T>(action: SetStateAction<T>, current: T): T {
  return typeof action === "function" ? (action as (value: T) => T)(current) : action;
}

const CLOSED_ACCOUNT_SERVICES: PublicFeatures = {
  douyinAccountServicesEnabled: false,
  invitationRedeemed: false,
};

async function readPublicFeatures(): Promise<PublicFeatures> {
  try {
    const response = await fetch("/api/features", { cache: "no-store" });
    if (!response.ok) return CLOSED_ACCOUNT_SERVICES;
    const payload = await response.json() as Partial<PublicFeatures>;
    return {
      douyinAccountServicesEnabled: payload.douyinAccountServicesEnabled === true,
      invitationRedeemed: payload.invitationRedeemed === true,
    };
  } catch {
    return CLOSED_ACCOUNT_SERVICES;
  }
}

function useDouyinAccountServices(): [PublicFeatures, () => Promise<void>] {
  const [features, setFeatures] = useState<PublicFeatures>(CLOSED_ACCOUNT_SERVICES);

  const refresh = useCallback(async () => {
    setFeatures(await readPublicFeatures());
  }, []);

  useEffect(() => {
    let active = true;
    void readPublicFeatures().then((nextFeatures) => {
      if (active) setFeatures(nextFeatures);
    });
    return () => {
      active = false;
    };
  }, []);

  return [features, refresh];
}

export default function HomePage() {
  const [{ douyinAccountServicesEnabled, invitationRedeemed }, refreshAccountServices] = useDouyinAccountServices();
  const router = useRouter();
  const [initialSession] = useState(() => createWorkflowSession());
  const [activeSessionId, setActiveSessionId] = useState(initialSession.historyRecordId);
  const [inputDraft, setInputDraft] = useState<{ sessionId: string; value: string } | null>(null);
  const [workflowSessions, setWorkflowSessions] = useState<Record<string, DouyinWorkflowSession>>(() => ({
    [initialSession.historyRecordId]: initialSession,
  }));
  const [liveTranscribeSessions, setLiveTranscribeSessions] = useState<Record<string, LiveTranscribeSession>>({});
  const [toast, setToast] = useState<{ message: string; tone: "error" | "info" } | null>(null);
  const [historyDetail, setHistoryDetail] = useState<TranscriptHistoryDetail | null>(null);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [historyList, setHistoryList] = useState<TranscriptHistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [historySidebarOpen, setHistorySidebarOpen] = useState(true);
  const [liveHistorySummariesByRecordId, setLiveHistorySummariesByRecordId] = useState<Record<string, TranscriptHistorySummary[]>>({});
  const hasAcceptedUsage = useSyncExternalStore(
    subscribeUsageConsent,
    readUsageConsent,
    readServerUsageConsent,
  );
  const [currentUser, setCurrentUser] = useState<CurrentUser | null | undefined>(undefined);
  const [asrQuota, setAsrQuota] = useState<AsrQuota | null | undefined>(undefined);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [invitationDialogOpen, setInvitationDialogOpen] = useState(false);
  const historyListRequestIdRef = useRef(0);
  const hasRestoredCurrentWorkflowRef = useRef(false);
  const isReadingClipboardRef = useRef(false);
  const resolveRequestIdsRef = useRef(new Map<string, number>());
  const activeSessionIdRef = useRef(activeSessionId);
  const transcribeAbortControllersRef = useRef(new Map<string, AbortController>());
  const userMenuRef = useRef<HTMLDivElement>(null);
  const activeSession = workflowSessions[activeSessionId] ?? initialSession;
  const {
    asrModel,
    emptyFilterWords,
    error,
    errorCode,
    input: committedInput,
    isResolving,
    qwenAsrItnEnabled,
    results,
    signedFilterWords,
    speakerCount,
    speakerDiarizationEnabled,
    specialWordFilterEnabled,
    specialWordFilterPanelOpen,
    systemReservedFilter,
    work,
  } = activeSession;
  const input = inputDraft?.sessionId === activeSessionId ? inputDraft.value : committedInput;
  const updateWorkflowSession = useCallback((
    sessionId: string,
    update: (session: DouyinWorkflowSession) => DouyinWorkflowSession,
  ) => {
    setWorkflowSessions((current) => {
      const session = current[sessionId];
      return session ? { ...current, [sessionId]: update(session) } : current;
    });
  }, []);
  const setWorkflowSessionResultProcessing = useCallback((sessionId: string, isResultProcessing: boolean) => {
    updateWorkflowSession(sessionId, (session) => session.isResultProcessing === isResultProcessing
      ? session
      : { ...session, isResultProcessing });
  }, [updateWorkflowSession]);
  const setWork = useCallback<Dispatch<SetStateAction<ResolvedDouyinWork | null>>>((action) => {
    updateWorkflowSession(activeSessionId, (session) => ({
      ...session,
      work: resolveStateAction(action, session.work),
    }));
  }, [activeSessionId, updateWorkflowSession]);
  const setResults = useCallback<Dispatch<SetStateAction<ExtractionResult[]>>>((action) => {
    updateWorkflowSession(activeSessionId, (session) => ({
      ...session,
      results: resolveStateAction(action, session.results),
    }));
  }, [activeSessionId, updateWorkflowSession]);
  const setError = useCallback<Dispatch<SetStateAction<string | null>>>((action) => {
    updateWorkflowSession(activeSessionId, (session) => ({
      ...session,
      error: resolveStateAction(action, session.error),
      errorCode: undefined,
    }));
  }, [activeSessionId, updateWorkflowSession]);
  const setErrorCode = useCallback((code: string | undefined) => {
    updateWorkflowSession(activeSessionId, (session) => ({ ...session, errorCode: code }));
  }, [activeSessionId, updateWorkflowSession]);
  const setLastResolvedInput = useCallback<Dispatch<SetStateAction<string>>>((action) => {
    updateWorkflowSession(activeSessionId, (session) => ({
      ...session,
      lastResolvedInput: resolveStateAction(action, session.lastResolvedInput),
    }));
  }, [activeSessionId, updateWorkflowSession]);
  function setActiveSessionField<K extends keyof DouyinWorkflowSession>(
    field: K,
    action: SetStateAction<DouyinWorkflowSession[K]>,
  ) {
    updateWorkflowSession(activeSessionId, (session) => ({
      ...session,
      [field]: resolveStateAction(action, session[field]),
    }));
  }
  const setAsrModel: Dispatch<SetStateAction<AsrModelId>> = (action) => setActiveSessionField("asrModel", action);
  const setEmptyFilterWords: Dispatch<SetStateAction<string>> = (action) => setActiveSessionField("emptyFilterWords", action);
  const setQwenAsrItnEnabled: Dispatch<SetStateAction<boolean>> = (action) => setActiveSessionField("qwenAsrItnEnabled", action);
  const setSignedFilterWords: Dispatch<SetStateAction<string>> = (action) => setActiveSessionField("signedFilterWords", action);
  const setSpeakerCount: Dispatch<SetStateAction<string>> = (action) => setActiveSessionField("speakerCount", action);
  const setSpeakerDiarizationEnabled: Dispatch<SetStateAction<boolean>> = (action) => setActiveSessionField("speakerDiarizationEnabled", action);
  const setSpecialWordFilterEnabled: Dispatch<SetStateAction<boolean>> = (action) => setActiveSessionField("specialWordFilterEnabled", action);
  const setSpecialWordFilterPanelOpen: Dispatch<SetStateAction<boolean>> = (action) => setActiveSessionField("specialWordFilterPanelOpen", action);
  const setSystemReservedFilter: Dispatch<SetStateAction<boolean>> = (action) => setActiveSessionField("systemReservedFilter", action);
  const closeUserMenu = useCallback(() => {
    setUserMenuOpen(false);
  }, []);
  const showToast = useCallback((message: string, tone: "error" | "info" = "error") => {
    setToast({ message, tone });
  }, []);
  const loadAsrQuota = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/douyin/transcribe/quota", { cache: "no-store", signal });
      if (!response.ok) {
        setAsrQuota(null);
        return;
      }
      setAsrQuota(await response.json() as AsrQuota);
    } catch (quotaError) {
      if (isAbortError(quotaError)) {
        return;
      }
      setAsrQuota(null);
    }
  }, []);
  const redirectToLogin = useCallback(() => {
    const next = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`;
    router.push(`/login?next=${encodeURIComponent(next || "/")}`);
  }, [router]);
  const historyWork = useMemo(
    () => historyDetail ? historyRecordToWork(historyDetail.record) : null,
    [historyDetail],
  );
  const workflowWorks = useMemo(
    () => [
      ...Object.values(workflowSessions).flatMap((session) => session.work ? [session.work] : []),
      ...(historyWork ? [historyWork] : []),
    ],
    [historyWork, workflowSessions],
  );
  const applyWorkMetadata = useCallback((workKey: string, metadata: WorkMetadataPatch) => {
    setWorkflowSessions((current) => Object.fromEntries(Object.entries(current).map(([sessionId, session]) => {
      if (!session.work || getWorkKey(session.work) !== workKey) return [sessionId, session];
      return [sessionId, {
        ...session,
        work: mergeWorkMetadata(session.work, metadata),
      }];
    })));
    setHistoryDetail((current) => current && current.record.workKey === workKey
      ? {
          ...current,
          record: {
            ...current.record,
            ...metadata,
          },
        }
      : current);
  }, []);
  const displayedWork = historyWork ?? work;
  const cachedAssetWorkKey = displayedWork ? getWorkKey(displayedWork) : "";
  const {
    avatar: cachedAvatar,
    avatarUrl: cachedAuthorAvatarUrl,
    cachedAssets,
    loadingWorkKeys,
    retryAsset,
    retryWork,
  } = useWorkPreparation(
    workflowWorks,
    cachedAssetWorkKey,
    historyDetail?.record.id ?? activeSession.historyRecordId,
    applyWorkMetadata,
    redirectToLogin,
  );
  const isHistoryMode = Boolean(historyDetail);

  const normalizedInput = input.trim();
  const activeKind = displayedWork && (isHistoryMode || hasAcceptedUsage) ? displayedWork.kind : null;
  const displayWork = activeKind ? displayedWork : null;
  const activeWorkKey = displayWork ? getWorkKey(displayWork) : "";
  const activeLiveSession = liveTranscribeSessions[activeSessionId] ?? null;
  const isTranscribing = Boolean(activeLiveSession?.isRunning);
  const transcribeStatusMessage = activeLiveSession?.statusMessage ?? "";
  const sidebarEntries = useMemo(() => buildSidebarEntries({
    historyRecords: historyList,
    liveTranscribeSessions,
    loadingWorkKeys,
    workflowSessions,
  }), [historyList, liveTranscribeSessions, loadingWorkKeys, workflowSessions]);
  const activeSidebarId = historyDetail ? historyDetail.record.id : activeSessionId;

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const restoreCurrentWorkflow = useCallback((snapshot: CurrentWorkflowSnapshot | null) => {
    if (!snapshot || !isCanonicalWorkflowSnapshot(snapshot)) {
      setLiveHistorySummariesByRecordId({});
      setLiveTranscribeSessions({});
      setHistoryDetail(null);
      setActiveSessionId(initialSession.historyRecordId);
      setWorkflowSessions({ [initialSession.historyRecordId]: initialSession });
      return;
    }
    const restoredHistoryDetail = snapshot.activeView?.kind === "history"
      ? snapshot.activeHistoryDetail ?? null
      : null;
    const restoredSessions = restoredHistoryDetail
      ? {
          ...snapshot.sessions,
          [restoredHistoryDetail.record.id]: mergeHistoryDetailIntoWorkflowSession(
            restoredHistoryDetail,
            snapshot.sessions[restoredHistoryDetail.record.id],
          ),
        }
      : snapshot.sessions;
    setActiveSessionId(restoredHistoryDetail?.record.id ?? snapshot.activeHistoryRecordId);
    setHistoryDetail(restoredHistoryDetail);
    setLiveHistorySummariesByRecordId(snapshot.liveHistorySummariesByRecordId);
    setLiveTranscribeSessions(snapshot.liveTranscribeSessions);
    setWorkflowSessions(restoredSessions);
  }, [initialSession]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    const controller = new AbortController();
    const refresh = () => void loadAsrQuota(controller.signal);
    queueMicrotask(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [currentUser, loadAsrQuota]);

  useEffect(() => {
    if (currentUser === undefined) return;

    let canceled = false;
    const navigationInput = new URL(window.location.href).searchParams.get("transcribe")?.trim();
    queueMicrotask(async () => {
      const snapshot = currentUser
        ? await readCurrentWorkflow(currentUser.id)
        : null;
      if (canceled) return;
      if (navigationInput) {
        setInputDraft({
          sessionId: initialSession.historyRecordId,
          value: navigationInput,
        });
        const url = new URL(window.location.href);
        url.searchParams.delete("transcribe");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      } else {
        restoreCurrentWorkflow(snapshot);
      }
      hasRestoredCurrentWorkflowRef.current = true;
    });
    return () => {
      canceled = true;
    };
  }, [currentUser, initialSession.historyRecordId, restoreCurrentWorkflow]);

  useEffect(() => {
    if (!hasRestoredCurrentWorkflowRef.current || !currentUser) {
      return;
    }
    writeCurrentWorkflow({
      activeHistoryDetail: historyDetail ?? undefined,
      activeHistoryRecordId: activeSessionId,
      activeView: historyDetail
        ? { id: historyDetail.record.id, kind: "history" }
        : { id: activeSessionId, kind: "workflow" },
      liveHistorySummariesByRecordId,
      liveTranscribeSessions,
      sessions: workflowSessions,
      userId: currentUser.id,
    });
  }, [activeSessionId, currentUser, historyDetail, liveHistorySummariesByRecordId, liveTranscribeSessions, workflowSessions]);
  const originalAudioCache = activeKind === "video" && cachedAssets.originalAudio?.workKey === activeWorkKey
    ? cachedAssets.originalAudio
    : undefined;
  const isOriginalAudioReady = Boolean(
    originalAudioCache?.url &&
    originalAudioCache.objectKey &&
    originalAudioCache.verified === true,
  );
  const isOriginalAudioPreparing = activeKind === "video" &&
    !isOriginalAudioReady &&
    originalAudioCache?.isLoading === true;
  const failedCachedAsset = activeKind === "video"
    ? Object.values(cachedAssets).find((asset) => asset?.error && !asset.url)
    : undefined;
  const assetCacheError = failedCachedAsset?.error || "";
  const isFailedAssetRetrying = activeKind === "video"
    && Object.values(cachedAssets).some((asset) => asset?.error && asset.isLoading);
  const originalAudioError = activeKind === "video" && !isOriginalAudioReady && originalAudioCache?.error
    ? originalAudioCache.error
    : "";
  const resourceCacheError = originalAudioError || assetCacheError;
  const resourceCacheErrorCode = originalAudioError
    ? originalAudioCache?.errorCode
    : failedCachedAsset?.errorCode;
  const sourceResults = historyDetail ? [historyRecordToResult(historyDetail.record)] : results;
  const visibleResults = sourceResults.filter((result) => result.feature === TRANSCRIPT_FEATURE);
  const hasVisibleResults = visibleResults.length > 0;
  const showTranscribeControls = Boolean(activeKind);
  const canTranscribe = Boolean(
    hasAcceptedUsage &&
    work?.kind === "video" &&
    isOriginalAudioReady &&
    !isTranscribing,
  );
  const parsedSpeakerCount = speakerCount.trim() ? Number(speakerCount) : undefined;
  const hasValidSpeakerCount = parsedSpeakerCount === undefined ||
    (Number.isInteger(parsedSpeakerCount) &&
      parsedSpeakerCount >= SPEAKER_COUNT_MIN &&
      parsedSpeakerCount <= SPEAKER_COUNT_MAX);
  const effectiveSpeakerCount = speakerDiarizationEnabled && parsedSpeakerCount !== undefined && hasValidSpeakerCount
    ? parsedSpeakerCount
    : undefined;
  const supportsQwenAsrOptions = asrModel === "e1" || asrModel === "e3";
  const supportsAsrEnhancementOptions = asrModel === "e2" || asrModel === "e3";
  const signedFilterWordList = parseSpecialWordInput(signedFilterWords);
  const emptyFilterWordList = parseSpecialWordInput(emptyFilterWords);
  const specialWordFilter = specialWordFilterEnabled && asrModel === "e2"
    ? buildSpecialWordFilterRequest({
        emptyWords: emptyFilterWordList,
        signedWords: signedFilterWordList,
        systemReservedFilter,
      })
    : undefined;
  const canStartTranscribe = canTranscribe &&
    (!speakerDiarizationEnabled || !supportsAsrEnhancementOptions || hasValidSpeakerCount);
  const hasPendingTranscribeJob = Boolean(activeLiveSession?.jobId);
  const transcribeActionLabel = "转录";
  const canRunTranscribeAction = isOriginalAudioReady && (hasPendingTranscribeJob
    ? Boolean(
        hasAcceptedUsage &&
        work?.kind === "video"
      )
    : canStartTranscribe);
  const canUseTranscribeAction = isTranscribing || canRunTranscribeAction;

  const ensureAuthenticated = useCallback((): boolean => {
    if (currentUser !== null) {
      return true;
    }

    redirectToLogin();
    return false;
  }, [currentUser, redirectToLogin]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timer = window.setTimeout(() => setToast(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const loadHistoryList = useCallback(async (query = historySearchQuery) => {
    const requestId = ++historyListRequestIdRef.current;
    if (!currentUser) {
      setHistoryList([]);
      return;
    }

    const normalizedQuery = query.trim();
    const cachedHistory = !normalizedQuery
      ? await readClientSessionCache<TranscriptHistoryCache>(currentUser.id, HISTORY_LIST_CACHE_KEY).catch(() => null)
      : null;
    if (cachedHistory) {
      setHistoryList(cachedHistory.records);
      setHistoryLoading(false);
      if (Date.now() - cachedHistory.refreshedAt < TRANSCRIPT_HISTORY_CACHE_TTL_MS) return;
    }

    const isBackgroundRefresh = Boolean(cachedHistory);
    if (!isBackgroundRefresh) {
      setHistoryLoading(true);
    }

    try {
      const records = await fetchTranscriptHistoryList(normalizedQuery);
      if (!normalizedQuery) {
        void writeClientSessionCache(currentUser.id, HISTORY_LIST_CACHE_KEY, {
          records,
          refreshedAt: Date.now(),
        } satisfies TranscriptHistoryCache).catch(() => undefined);
      }
      if (requestId !== historyListRequestIdRef.current) {
        return;
      }
      setHistoryList(records);
    } catch (loadError) {
      if (requestId !== historyListRequestIdRef.current) {
        return;
      }
      if (isAuthRequiredError(loadError)) {
        redirectToLogin();
        return;
      }
      showToast(readUserFacingError(loadError, "转录历史加载失败。"));
    } finally {
      if (!isBackgroundRefresh && requestId === historyListRequestIdRef.current) {
        setHistoryLoading(false);
      }
    }
  }, [currentUser, historySearchQuery, redirectToLogin, showToast]);

  function activateHistoryDetail(detail: TranscriptHistoryDetail) {
    const record = detail.record;
    const sessionId = record.id;

    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setWorkflowSessions((current) => ({
      ...current,
      [sessionId]: mergeHistoryDetailIntoWorkflowSession(detail, current[sessionId]),
    }));
    setHistoryDetail(detail);
    setHistoryDrawerOpen(false);
  }

  async function openHistoryRecord(id: string) {
    if (!ensureAuthenticated()) {
      return;
    }
    if (asrQuota?.exhausted && !asrQuota.configuredCustomApiKey) {
      setError("平台转录剩余额度不足，无法转录当前音频。请前往设置，配置正确且可用的自定义 API Key 后继续使用。");
      return;
    }

    try {
      const detailCacheKey = `history-detail:${id}`;
      const cachedDetail = currentUser
        ? await readClientSessionCache<TranscriptHistoryDetail>(currentUser.id, detailCacheKey).catch(() => null)
        : null;
      if (cachedDetail?.record.transcriptContent.trim()) {
        activateHistoryDetail(cachedDetail);
      }
      const detail = await fetchTranscriptHistoryDetail(id);
      if (currentUser) {
        void writeClientSessionCache(currentUser.id, detailCacheKey, detail).catch(() => undefined);
      }
      if (!detail.record.transcriptContent.trim()) {
        const existing = workflowSessions[id];
        if (existing) {
          openWorkflowSession(existing.historyRecordId);
          return;
        }
        const record = detail.record;
        const sessionId = record.id;
        const session: DouyinWorkflowSession = {
          ...createWorkflowSession(sessionId),
          input: record.inputUrl,
          lastResolvedInput: record.inputUrl,
          work: historyRecordToWork(record),
        };
        activeSessionIdRef.current = sessionId;
        setActiveSessionId(sessionId);
        setWorkflowSessions((current) => ({ ...current, [sessionId]: session }));
        setHistoryDetail(null);
        setHistoryDrawerOpen(false);
        return;
      }
      activateHistoryDetail(detail);
    } catch (loadError) {
      showToast(readUserFacingError(loadError, "转录历史加载失败。"));
    }
  }

  function showLiveSession() {
    setHistoryDetail(null);
    setHistoryDrawerOpen(false);
  }

  function openWorkflowSession(sessionId: string) {
    if (!workflowSessions[sessionId]) {
      return;
    }

    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setHistoryDetail(null);
    setHistoryDrawerOpen(false);
  }

  function activateWorkflowSession(session: DouyinWorkflowSession) {
    activeSessionIdRef.current = session.historyRecordId;
    setActiveSessionId(session.historyRecordId);
    setWorkflowSessions((current) => ({ ...current, [session.historyRecordId]: session }));
    setHistoryDetail(null);
    setHistoryDrawerOpen(false);
  }

  function createAndActivateWorkflowSession(input = ""): DouyinWorkflowSession {
    const session = { ...createWorkflowSession(), input };
    activateWorkflowSession(session);
    return session;
  }

  function renameWorkflowSession(id: string, sessionName: string) {
    updateWorkflowSession(id, (session) => ({ ...session, sessionName }));
  }

  function removeWorkflowSession(id: string) {
    if (!workflowSessions[id]) {
      return;
    }

    const liveSession = liveTranscribeSessions[id];
    const jobId = liveSession?.isRunning ? liveSession.jobId : "";
    resolveRequestIdsRef.current.delete(id);
    transcribeAbortControllersRef.current.get(id)?.abort();
    transcribeAbortControllersRef.current.delete(id);
    void cancelTranscribeJob(jobId);
    setLiveTranscribeSessions((current) => {
      if (!current[id]) {
        return current;
      }
      const next = { ...current };
      delete next[id];
      return next;
    });

    const fallbackSession = Object.values(workflowSessions)
      .filter((session) => session.historyRecordId !== id)
      .sort((first, second) => second.createdAt - first.createdAt)[0];
    const nextSession = fallbackSession ?? createWorkflowSession();
    const fallbackSessionId = nextSession.historyRecordId;
    if (activeSessionIdRef.current === id) {
      activeSessionIdRef.current = fallbackSessionId;
      setActiveSessionId(fallbackSessionId);
      setHistoryDetail(null);
      setHistoryDrawerOpen(false);
    }
    setWorkflowSessions((current) => {
      const next = { ...current };
      delete next[id];
      if (!Object.keys(next).length) {
        next[nextSession.historyRecordId] = nextSession;
      }
      return next;
    });
  }

  function startNewLiveSession() {
    createAndActivateWorkflowSession();
  }

  async function renameHistoryRecord(id: string, sessionName: string) {
    try {
      const nextRecord = await renameTranscriptHistory(id, sessionName);
      replaceHistoryRecord(nextRecord);
      setHistoryDetail((current) =>
        current?.record.id === id ? { ...current, record: nextRecord } : current
      );
    } catch (renameError) {
      showToast(readUserFacingError(renameError, "历史记录重命名失败。"));
    }
  }

  async function removeHistoryRecord(id: string) {
    try {
      await deleteTranscriptHistory(id);
      setHistoryList((current) => current.filter((record) => record.id !== id));
      if (currentUser) {
        updateTranscriptHistoryCache(currentUser.id, (records) => records.filter((record) => record.id !== id));
        void deleteClientSessionCache(currentUser.id, `history-detail:${id}`).catch(() => undefined);
      }
      if (historyDetail?.record.id === id) {
        showLiveSession();
      }
    } catch (deleteError) {
      showToast(readUserFacingError(deleteError, "历史记录删除失败。"));
    }
  }

  function replaceHistoryRecord(nextRecord: TranscriptHistoryRecord) {
    const replace = (records: TranscriptHistoryRecord[]) =>
      records.map((record) => record.id === nextRecord.id ? nextRecord : record);
    setHistoryList(replace);
    if (currentUser) {
      updateTranscriptHistoryCache(currentUser.id, replace);
    }
  }

  function openSidebarEntry(entry: SidebarEntry) {
    if (entry.isSession) {
      openWorkflowSession(entry.id);
      return;
    }
    void openHistoryRecord(entry.id);
  }

  function renameSidebarEntry(entry: SidebarEntry, sessionName: string) {
    if (entry.isSession) renameWorkflowSession(entry.id, sessionName);
    if (entry.hasRecord) void renameHistoryRecord(entry.id, sessionName);
  }

  function deleteSidebarEntry(entry: SidebarEntry) {
    if (entry.isSession) removeWorkflowSession(entry.id);
    if (entry.hasRecord) void removeHistoryRecord(entry.id);
  }

  async function toggleSidebarEntryPin(entry: SidebarEntry) {
    if (!entry.hasRecord) {
      showToast("会话完成转录并保存后才能置顶。");
      return;
    }
    try {
      replaceHistoryRecord(await setTranscriptHistoryPinned(entry.id, !entry.isPinned));
    } catch (pinError) {
      showToast(readUserFacingError(pinError, "会话置顶状态保存失败。"));
    }
  }

  function addHistorySummary(recordId: string, summary: TranscriptHistorySummary | undefined) {
    if (!summary) {
      return;
    }
    setHistoryDetail((current) => current
      ? {
          ...current,
          summaries: current.record.id === recordId
            ? [summary, ...current.summaries.filter((item) => item.id !== summary.id)]
            : current.summaries,
        }
      : current
    );
    setLiveHistorySummariesByRecordId((current) => ({
      ...current,
      [recordId]: [summary, ...(current[recordId] ?? []).filter((item) => item.id !== summary.id)],
    }));
  }

  function removeHistorySummary(recordId: string, summaryId: string) {
    setHistoryDetail((current) => current
      ? {
          ...current,
          summaries: current.record.id === recordId
            ? current.summaries.filter((item) => item.id !== summaryId)
            : current.summaries,
        }
      : current
    );
    setLiveHistorySummariesByRecordId((current) => ({
      ...current,
      [recordId]: (current[recordId] ?? []).filter((item) => item.id !== summaryId),
    }));
  }

  async function updateHistoryTranscript(input: {
    recordId: string;
    transcriptContent: string;
    transcriptSegments: TranscriptSegment[];
  }, workflowSessionId?: string): Promise<TranscriptHistoryRecord> {
    const nextRecord = await updateTranscriptHistoryTranscript({
      id: input.recordId,
      transcriptContent: input.transcriptContent,
      transcriptSegments: input.transcriptSegments,
    });

    upsertHistoryListItem(nextRecord);
    setHistoryDetail((current) =>
      current?.record.id === nextRecord.id ? { ...current, record: nextRecord } : current
    );
    if (workflowSessionId) {
      updateWorkflowSession(workflowSessionId, (session) => ({
        ...session,
        results: session.results.map((result) => result.feature === TRANSCRIPT_FEATURE
          ? {
              ...result,
              content: nextRecord.transcriptContent,
              transcriptSegments: nextRecord.transcriptSegments,
            }
          : result),
      }));
    }
    return nextRecord;
  }

  const upsertHistoryListItem = useCallback((record: TranscriptHistoryRecord) => {
    const upsert = (current: TranscriptHistoryRecord[]) => [
      record,
      ...current.filter((item) => item.id !== record.id),
    ].sort((first, second) => second.updatedAt - first.updatedAt);
    setHistoryList(upsert);
    if (currentUser) {
      updateTranscriptHistoryCache(currentUser.id, upsert);
    }
  }, [currentUser]);

  function updateSpecialWordFilterEnabled(checked: boolean) {
    setSpecialWordFilterEnabled(checked);
    setSpecialWordFilterPanelOpen(checked);
  }

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    const timer = window.setTimeout(() => {
      void loadHistoryList(historySearchQuery);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [currentUser, historySearchQuery, loadHistoryList]);

  function updateAsrModel(model: AsrModelId) {
    setAsrModel(model);
    if (model !== "e2") {
      setSpeakerDiarizationEnabled(false);
      setSpecialWordFilterEnabled(false);
      setSpecialWordFilterPanelOpen(false);
    }
  }

  useEffect(() => {
    let isActive = true;

    async function readCurrentUser() {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        if (!response.ok) {
          if (isActive) {
            setCurrentUser(null);
          }
          return;
        }

        const payload = await response.json() as { user?: CurrentUser };
        if (isActive) {
          setCurrentUser(payload.user ?? null);
        }
      } catch {
        if (isActive) {
          setCurrentUser(null);
        }
      }
    }

    void readCurrentUser();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!userMenuOpen) {
      return;
    }

    function closeUserMenuOnPointerDown(event: PointerEvent) {
      if (userMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      closeUserMenu();
    }

    function closeUserMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeUserMenu();
      }
    }

    document.addEventListener("pointerdown", closeUserMenuOnPointerDown);
    document.addEventListener("keydown", closeUserMenuOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeUserMenuOnPointerDown);
      document.removeEventListener("keydown", closeUserMenuOnEscape);
    };
  }, [closeUserMenu, userMenuOpen]);

  async function resolveInput(input: {
    compareWithFinalUrl?: string;
    compareWithWorkKey?: string;
    createSessionOnSuccess: boolean;
    sourceSessionId: string;
    targetSession: DouyinWorkflowSession;
    value: string;
  }) {
    const valueToResolve = input.value.trim();
    const sessionId = input.sourceSessionId;
    const clearSubmittedDraft = () => setInputDraft((current) =>
      current?.sessionId === sessionId && current.value.trim() === valueToResolve ? null : current
    );
    const requestId = (resolveRequestIdsRef.current.get(sessionId) ?? 0) + 1;
    resolveRequestIdsRef.current.set(sessionId, requestId);

    if (!valueToResolve) {
      updateWorkflowSession(sessionId, (session) => ({ ...session, error: "请输入抖音或 Bilibili 分享链接。" }));
      return;
    }

    if (!ensureAuthenticated()) {
      return;
    }

    updateWorkflowSession(sessionId, (session) => ({
      ...session,
      error: null,
      input: input.createSessionOnSuccess ? session.input : valueToResolve,
      isResolving: true,
    }));

    try {
      const response = await fetch("/api/media/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentFinalUrl: input.compareWithFinalUrl,
          currentWorkKey: input.compareWithWorkKey,
          historyRecordId: input.targetSession.historyRecordId,
          input: valueToResolve,
        }),
      });
      const payload = await readApiPayload(response, "识别链接失败。");
      if (isUnauthenticatedApiResponse(response, payload)) {
        throw new AuthRequiredError();
      }

      if (!response.ok || !isResolvedWorkPayload(payload)) {
        throwApiError(getApiError(payload), "识别链接失败。");
      }

      if (requestId !== resolveRequestIdsRef.current.get(sessionId)) {
        return;
      }
      if ("sameAsCurrent" in payload) {
        clearSubmittedDraft();
        showToast("该链接与当前作品相同，无需重复处理。", "info");
        return;
      }
      const resolvedPayload = payload as {
        historyRecord?: TranscriptHistoryRecord;
        reusedExistingSession?: boolean;
        work: ResolvedDouyinWork;
      };

      const historyRecord = resolvedPayload.historyRecord;
      if (resolvedPayload.reusedExistingSession && historyRecord) {
        clearSubmittedDraft();
        upsertHistoryListItem(historyRecord);
        if (!input.createSessionOnSuccess && sessionId !== historyRecord.id) {
          removeWorkflowSession(sessionId);
        }
        await openHistoryRecord(historyRecord.id);
        showToast("该作品已有会话，已为你恢复。", "info");
        return;
      }

      const resolvedSession: DouyinWorkflowSession = {
        ...input.targetSession,
        error: null,
        input: valueToResolve,
        lastResolvedInput: valueToResolve,
        results: [],
        work: resolvedPayload.work,
      };
      if (input.createSessionOnSuccess) {
        activateWorkflowSession(resolvedSession);
      } else {
        updateWorkflowSession(resolvedSession.historyRecordId, () => resolvedSession);
      }
      clearSubmittedDraft();
      if (historyRecord) upsertHistoryListItem(historyRecord);
    } catch (resolveError) {
      if (requestId !== resolveRequestIdsRef.current.get(sessionId)) {
        return;
      }
      if (isAuthRequiredError(resolveError)) {
        redirectToLogin();
        return;
      }
      updateWorkflowSession(sessionId, (session) => ({
        ...session,
        error: readUserFacingError(resolveError, "识别链接失败。"),
        errorCode: readUserFacingErrorCode(resolveError),
      }));
    } finally {
      if (requestId === resolveRequestIdsRef.current.get(sessionId)) {
        updateWorkflowSession(sessionId, (session) => ({ ...session, isResolving: false }));
      }
    }
  }

  useEffect(() => {
    let isActive = true;

    async function fillFromClipboard() {
      if (isReadingClipboardRef.current) {
        return;
      }

      isReadingClipboardRef.current = true;
      const clipboard = await readClipboardMediaInput();
      isReadingClipboardRef.current = false;

      const hasInputDraft = inputDraft?.sessionId === activeSessionId;
      if (isActive && !hasInputDraft && clipboard && !isSameMediaInput(input, clipboard)) {
        setInputDraft({ sessionId: activeSessionId, value: clipboard.text });
      }
    }

    function retryFromClipboard() {
      void fillFromClipboard();
    }

    window.addEventListener("focus", retryFromClipboard);
    window.addEventListener("pointerdown", retryFromClipboard, { capture: true });
    window.addEventListener("keydown", retryFromClipboard, { capture: true });
    document.addEventListener("visibilitychange", retryFromClipboard);

    return () => {
      isActive = false;
      window.removeEventListener("focus", retryFromClipboard);
      window.removeEventListener("pointerdown", retryFromClipboard, { capture: true });
      window.removeEventListener("keydown", retryFromClipboard, { capture: true });
      document.removeEventListener("visibilitychange", retryFromClipboard);
    };
  }, [activeSessionId, input, inputDraft?.sessionId]);

  async function transcribe() {
    if (isTranscribing) {
      await cancelTranscribe();
      return;
    }
    if (!work || isTranscribing) {
      return;
    }
    if (!ensureAuthenticated()) {
      return;
    }
    if (
      !activeLiveSession?.jobId &&
      (!canStartTranscribe || !activeWorkKey)
    ) {
      return;
    }

    const controller = new AbortController();
    const sessionId = activeSessionId;
    const sessionWorkKey = activeWorkKey;
    const sessionInput = committedInput.trim();
    const sessionWork = work;
    const clientJobId = activeLiveSession?.jobId || createClientJobId();
    const historyRecordId = activeSession.historyRecordId;
    const nextLiveSession: LiveTranscribeSession = {
      input: sessionInput,
      isRunning: true,
      jobId: activeLiveSession?.jobId ?? "",
      persisted: false,
      results: activeLiveSession?.results ?? [],
      statusMessage: "转录任务处理中，完成后会自动展示结果...",
      work: sessionWork,
      workKey: sessionWorkKey,
    };
    transcribeAbortControllersRef.current.set(sessionId, controller);
    setLiveTranscribeSessions((current) => ({ ...current, [sessionId]: nextLiveSession }));
    setError(null);

    try {
      if (activeLiveSession?.jobId) {
        await pollPendingTranscribeResult(
          activeLiveSession.jobId,
          sessionId,
          sessionInput,
          controller.signal,
        );
        return;
      }

      const response = await fetch("/api/douyin/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientJobId,
          diarizationEnabled: supportsAsrEnhancementOptions && speakerDiarizationEnabled,
          ...(supportsQwenAsrOptions && qwenAsrItnEnabled ? { enableItn: true } : {}),
          historyRecordId,
          model: asrModel,
          specialWordFilter,
          speakerCount: effectiveSpeakerCount,
        }),
        signal: controller.signal,
      });
      const outcome = await consumeTranscribeResponse(response, "转录失败。", {
        input: sessionInput,
        sessionId,
      });
      if (outcome.type === "running") {
        setResults([]);
        await pollPendingTranscribeResult(outcome.jobId, sessionId, sessionInput, controller.signal);
      }
    } catch (transcribeError) {
      if (isAbortError(transcribeError)) {
        return;
      }
      if (isAuthRequiredError(transcribeError)) {
        redirectToLogin();
        return;
      }
      const message = readUserFacingError(transcribeError, "转录失败。");
      setLiveTranscribeSessions((current) => {
        const session = current[sessionId];
        return session ? {
          ...current,
          [sessionId]: { ...session, isRunning: false, statusMessage: message },
        } : current;
      });
      setError(message);
      setErrorCode(readUserFacingErrorCode(transcribeError));
    } finally {
      if (transcribeAbortControllersRef.current.get(sessionId) === controller) {
        transcribeAbortControllersRef.current.delete(sessionId);
      }
      setLiveTranscribeSessions((current) => {
        const session = current[sessionId];
        return session ? { ...current, [sessionId]: { ...session, isRunning: false } } : current;
      });
    }
  }

  async function cancelTranscribe() {
    const jobId = activeLiveSession?.jobId ?? "";
    const sessionId = activeSessionId;
    transcribeAbortControllersRef.current.get(sessionId)?.abort();
    transcribeAbortControllersRef.current.delete(sessionId);
    setLiveTranscribeSessions((current) => {
      if (!current[sessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setError(null);

    if (!jobId) {
      return;
    }

    await cancelTranscribeJob(jobId);
  }

  function detectInput() {
    if (!hasAcceptedUsage) {
      setError("请先确认仅用于个人学习和非商业用途，并尊重原作者版权。");
      return;
    }
    if (!ensureAuthenticated()) {
      return;
    }

    const createSessionOnSuccess = Boolean(work);
    const targetSession = createSessionOnSuccess
      ? { ...createWorkflowSession(), input: normalizedInput }
      : { ...activeSession, input: normalizedInput };
    void resolveInput({
      compareWithFinalUrl: createSessionOnSuccess ? work?.finalUrl : undefined,
      compareWithWorkKey: createSessionOnSuccess ? activeWorkKey : undefined,
      createSessionOnSuccess,
      sourceSessionId: activeSessionId,
      targetSession,
      value: normalizedInput,
    });
  }

  function updateUsageConsent(value: boolean) {
    if (value) {
      window.localStorage.setItem(USAGE_CONSENT_STORAGE_KEY, "true");
    } else {
      window.localStorage.removeItem(USAGE_CONSENT_STORAGE_KEY);
    }
    window.dispatchEvent(new Event(USAGE_CONSENT_EVENT));
    if (value && error === "请先确认仅用于个人学习和非商业用途，并尊重原作者版权。") {
      setError(null);
    }
  }

  async function pollPendingTranscribeResult(
    jobId: string,
    sessionId: string,
    sessionInput: string,
    signal: AbortSignal,
  ) {
    let elapsedMs = 0;
    setLiveTranscribeSessions((current) => {
      const session = current[sessionId];
      return session ? { ...current, [sessionId]: { ...session, jobId } } : current;
    });

    while (!signal.aborted) {
      const settled = await fetchPendingTranscribeResult(jobId, sessionId, sessionInput, signal);
      if (settled) {
        return;
      }

      if (elapsedMs >= TRANSCRIBE_POLL_TIMEOUT_MS) {
        setLiveTranscribeSessions((current) => {
          const session = current[sessionId];
          return session ? {
            ...current,
            [sessionId]: {
              ...session,
              isRunning: false,
              statusMessage: "转录任务仍在处理中，稍后点击“转录”继续刷新。",
            },
          } : current;
        });
        return;
      }

      await abortableSleep(TRANSCRIBE_POLL_INTERVAL_MS, signal);
      elapsedMs += TRANSCRIBE_POLL_INTERVAL_MS;
    }
  }

  async function fetchPendingTranscribeResult(
    jobId: string,
    sessionId: string,
    sessionInput: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!jobId) {
      return false;
    }

    const query = new URLSearchParams({ jobId });
    const response = await fetch(`/api/douyin/transcribe?${query}`, {
      cache: "no-store",
      signal,
    });
    const outcome = await consumeTranscribeResponse(response, "转录结果获取失败。", {
      input: sessionInput,
      sessionId,
    });
    return outcome.type === "done";
  }

  async function consumeTranscribeResponse(
    response: Response,
    fallback: string,
    sessionContext: { input: string; sessionId: string },
  ): Promise<TranscribeStreamOutcome> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      const payload = await readApiPayload(response, fallback) as ApiError;
      if (isUnauthenticatedApiResponse(response, payload)) {
        throw new AuthRequiredError();
      }
      throwApiError(getApiError(payload), fallback);
    }

    for await (const event of readJsonEventStream<TranscribeStreamEvent>(response.body)) {
      if (event.type === "postprocess_start") {
        setLiveTranscribeSessions((current) => {
          const session = current[sessionContext.sessionId];
          return session ? {
            ...current,
            [sessionContext.sessionId]: { ...session, statusMessage: getPostprocessStatusMessage() },
          } : current;
        });
      } else if (event.type === "running") {
        void loadAsrQuota();
        const eventWork = event.work;
        if (eventWork) {
          setLastResolvedInput(sessionContext.input);
          setWork((current) => mergeResolvedWork(current, eventWork));
        }
        setLiveTranscribeSessions((current) => {
          const session = current[sessionContext.sessionId];
          return session ? {
            ...current,
            [sessionContext.sessionId]: {
              ...session,
              jobId: event.jobId,
              statusMessage: "转录任务处理中，完成后会自动展示结果...",
              work: eventWork ? mergeResolvedWork(session.work, eventWork) : session.work,
            },
          } : current;
        });
        return { type: "running", jobId: event.jobId };
      } else if (event.type === "done") {
        void loadAsrQuota();
        const eventWork = event.work;
        if (eventWork) {
          setWork((current) => mergeResolvedWork(current, eventWork));
        }
        const orderedResults = orderResults(event.results, [TRANSCRIPT_FEATURE]);
        let persisted = false;
        if (event.historyRecord) {
          const record = event.historyRecord;
          upsertHistoryListItem(record);
          setHistoryDetail((current) => current?.record.id === record.id
            ? { ...current, record }
            : current);
          persisted = true;
        }
        setLiveTranscribeSessions((current) => {
          const session = current[sessionContext.sessionId];
          if (!session) {
            return current;
          }
          return {
            ...current,
            [sessionContext.sessionId]: {
              ...session,
              isRunning: false,
              jobId: "",
              persisted,
              results: orderedResults,
              statusMessage: "",
              work: eventWork ? mergeResolvedWork(session.work, eventWork) : session.work,
            },
          };
        });
        setLastResolvedInput(sessionContext.input);
        setResults(orderedResults);
        return { type: "done" };
      } else if (event.type === "error") {
        void loadAsrQuota();
        setLiveTranscribeSessions((current) => {
          const session = current[sessionContext.sessionId];
          return session ? {
            ...current,
            [sessionContext.sessionId]: {
              ...session,
              isRunning: false,
              jobId: "",
              statusMessage: event.error,
            },
          } : current;
        });
        throw codedError(event.error, event.code);
      }
    }

    throw new Error(fallback);
  }
  function updateInput(value: string) {
    setInputDraft({ sessionId: activeSessionId, value });
    if (!value.trim()) {
      setError(null);
    }
  }

  function clearInput() {
    setInputDraft({ sessionId: activeSessionId, value: "" });
    setError(null);
  }

  async function logout() {
    closeUserMenu();
    for (const controller of transcribeAbortControllersRef.current.values()) {
      controller.abort();
    }
    transcribeAbortControllersRef.current.clear();
    await fetch("/api/auth/logout", { method: "POST" });
    if (currentUser) clearCurrentWorkflow(currentUser.id);
    setLiveTranscribeSessions({});
    setHistoryList([]);
    setHistoryDetail(null);
    setAsrQuota(null);
    setCurrentUser(null);
    router.refresh();
  }

  return (
    <main className="app-shell h-[100dvh] overflow-hidden bg-background text-foreground">
      {toast ? <TopToast message={toast.message} onDismiss={() => setToast(null)} tone={toast.tone} /> : null}
      {invitationDialogOpen ? (
        <InvitationDialog
          invitationRedeemed={invitationRedeemed}
          onClose={() => setInvitationDialogOpen(false)}
          onRedeemed={() => {
            setInvitationDialogOpen(false);
            void refreshAccountServices();
            showToast("账号功能已永久开通。", "info");
          }}
        />
      ) : null}
      <div className="relative z-10 flex h-full w-full min-w-0 gap-0 overflow-hidden">
        <TranscriptHistorySidebar
          activeId={activeSidebarId}
          douyinAccountServicesEnabled={douyinAccountServicesEnabled}
          entries={sidebarEntries}
          isDrawerOpen={historyDrawerOpen}
          isOpen={historySidebarOpen}
          isLoading={historyLoading}
          onCloseDrawer={() => setHistoryDrawerOpen(false)}
          onDelete={deleteSidebarEntry}
          onNew={startNewLiveSession}
          onOpen={openSidebarEntry}
          onOpenInvitation={() => setInvitationDialogOpen(true)}
          onRename={renameSidebarEntry}
          onReturnLive={showLiveSession}
          onSearch={setHistorySearchQuery}
          onToggle={() => setHistorySidebarOpen((open) => !open)}
          onTogglePin={toggleSidebarEntryPin}
          query={historySearchQuery}
          showReturnLive={Boolean(historyDetail)}
        />
        <div
          className="content-scroll flex h-full min-w-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 sm:px-5 md:gap-7 md:py-10"
        >
          <button
            type="button"
            onClick={() => setHistoryDrawerOpen(true)}
            className="inline-flex h-9 w-fit items-center gap-2 rounded-md border border-white/12 bg-white/[0.04] px-3 text-sm font-semibold text-cyan transition hover:bg-cyan/[0.08] md:hidden"
          >
            <PanelLeft className="size-4" aria-hidden="true" />
            转录历史
          </button>
        <div className="relative min-h-12 pr-12 sm:pr-36">
          <div className="flex min-w-0 items-center justify-start gap-3">
            <Image
              src="/echolens-logo.svg"
              alt=""
              width={50}
              height={45}
              className="h-12 w-[3.375rem] shrink-0 object-contain"
            />
            <div className="min-w-0 space-y-1">
              <h1 className="text-2xl font-semibold text-foreground">EchoLens</h1>
              <p className="truncate text-sm text-muted-foreground">透视视频作品的声音与文字</p>
            </div>
          </div>
          <div className="absolute right-0 top-0">
            {currentUser ? (
              <div ref={userMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => {
                    if (userMenuOpen) {
                      closeUserMenu();
                      return;
                    }
                    setUserMenuOpen(true);
                  }}
                  className="inline-flex size-11 select-none items-center justify-center rounded-full border border-white/10 bg-muted text-base font-semibold text-foreground shadow-[inset_0_1px_0_rgb(255_255_255_/_0.06)] transition hover:border-cyan/35 hover:bg-cyan/[0.12] hover:text-cyan active:scale-[0.96]"
                  aria-expanded={userMenuOpen}
                  aria-haspopup="dialog"
                  aria-label={`${currentUser.username} 用户菜单`}
                  title={currentUser.username}
                >
                  {getAvatarInitial(currentUser)}
                </button>

                <aside
                  aria-hidden={!userMenuOpen}
                  className={cn(
                    "absolute right-0 top-12 z-40 flex max-h-[min(36rem,calc(100dvh-5rem))] w-[min(18rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-white/12 bg-background/95 p-2 shadow-2xl shadow-black/45 backdrop-blur-xl transition duration-150 ease-out",
                    userMenuOpen
                      ? "pointer-events-auto translate-y-0 opacity-100"
                      : "pointer-events-none -translate-y-1 opacity-0",
                  )}
                  aria-label="用户菜单"
                  role="dialog"
                >
                  <div className="mb-2 flex items-center gap-2 border-b border-white/10 px-2 pb-2 pt-1">
                    <span className="inline-flex size-9 shrink-0 select-none items-center justify-center rounded-full border border-cyan/35 bg-cyan/[0.08] text-sm font-semibold text-cyan">
                      {getAvatarInitial(currentUser)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{currentUser.username}</p>
                      <p className="truncate text-xs text-muted-foreground">{currentUser.email}</p>
                    </div>
                    <button
                      type="button"
                      onClick={closeUserMenu}
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-cyan active:scale-[0.96]"
                      aria-label="关闭用户菜单"
                      title="关闭用户菜单"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </div>

                  <div className="grid gap-0.5 py-1">
                    {currentUser.role === "admin" ? (
                      <Link
                        href="/admin/invitations"
                        onClick={closeUserMenu}
                        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] font-semibold text-foreground transition hover:bg-white/8 hover:text-cyan active:scale-[0.98]"
                      >
                        <ShieldCheck className="size-4 text-amber" aria-hidden="true" />
                        控制台
                      </Link>
                    ) : null}
                    <Link
                      href="/settings"
                      onClick={closeUserMenu}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] font-semibold text-foreground transition hover:bg-white/8 hover:text-cyan active:scale-[0.98]"
                    >
                      <Settings className="size-4 text-cyan" aria-hidden="true" />
                      设置
                    </Link>
                  </div>

                  <div className="mt-1 border-t border-white/10 pt-1">
                    <button
                      type="button"
                      onClick={() => void logout()}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] font-semibold text-destructive transition hover:bg-destructive/10 active:scale-[0.98]"
                    >
                      <LogOut className="size-4" aria-hidden="true" />
                      退出登录
                    </button>
                  </div>
                </aside>
              </div>
            ) : currentUser === null ? (
              <Link
                href="/login?next=%2F"
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-cyan/35 bg-cyan/[0.08] px-2 text-sm font-semibold text-cyan transition hover:border-cyan/55 hover:bg-cyan/[0.12] active:scale-[0.98] sm:px-3"
                aria-label="登录"
                title="登录"
              >
                <LogIn className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">登录</span>
              </Link>
            ) : (
              <div className="h-9 w-11 sm:w-20" aria-hidden="true" />
            )}
          </div>
        </div>

        {!isHistoryMode ? (
        <div className="flex flex-col gap-2">
          <div className="order-1 flex min-w-0 items-start gap-3 rounded-md bg-black/20 px-0 py-2 text-left md:order-2">
            <span className="relative mt-0.5 shrink-0">
              <input
                type="checkbox"
                checked={hasAcceptedUsage}
                onChange={(event) => updateUsageConsent(event.target.checked)}
                aria-labelledby="usage-consent-description"
                className="peer absolute inset-0 z-10 cursor-pointer opacity-0"
              />
              <span
                aria-hidden="true"
                className="flex size-[1.05rem] items-center justify-center rounded-[0.28rem] border border-white/28 bg-white/[0.03] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.06),0_0_0_1px_rgb(0_0_0_/_0.2)] transition peer-hover:border-cyan/55 peer-focus-visible:border-cyan/70 peer-focus-visible:ring-2 peer-focus-visible:ring-cyan/20 peer-checked:border-cyan/80 peer-checked:bg-white/[0.02] peer-checked:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08),0_0_0_1px_rgb(0_0_0_/_0.18),0_0_16px_rgb(34_211_238_/_0.12)] peer-checked:[&_svg]:opacity-100"
              >
                <Check className="size-[0.82rem] text-cyan opacity-0 drop-shadow-[0_0_6px_rgba(34,211,238,0.45)] transition duration-150 ease-out" strokeWidth={3.4} />
              </span>
            </span>
            <span id="usage-consent-description" className="mobile-readable min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
              我确认仅用于个人学习和非商业用途，并尊重原作者版权；已阅读并同意
              <Link
                href="/legal"
                className="mx-1 font-semibold text-cyan underline decoration-cyan/50 underline-offset-4 transition hover:text-amber hover:decoration-amber"
              >
                法律声明
              </Link>
            </span>
          </div>

          <div className="order-2 flex flex-col gap-3 md:order-1 md:flex-row md:items-center">
            <div
              className={cn(
                "flex h-11 flex-1 items-center gap-3 rounded-md border bg-black/20 px-4 transition",
                hasAcceptedUsage
                  ? "border-cyan/35 focus-within:border-cyan/80 focus-within:ring-2 focus-within:ring-cyan/20"
                  : "border-white/25",
              )}
            >
              <Link2 className={cn("size-5 shrink-0", hasAcceptedUsage ? "text-amber" : "text-muted-foreground")} />
              <details className="group relative shrink-0">
                <summary
                  className="inline-flex size-7 cursor-pointer list-none items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.08] hover:text-amber focus-visible:bg-cyan/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/35 group-open:bg-cyan/[0.08] group-open:text-amber [&::-webkit-details-marker]:hidden"
                  aria-label="查看自动粘贴隐私说明"
                >
                  <AlertCircle className="size-4" aria-hidden="true" />
                </summary>
                <div
                  role="note"
                  className="absolute left-0 top-full z-30 mt-2 w-[min(20rem,calc(100vw-3rem))] rounded-md border border-cyan/30 bg-[#0b1118]/95 px-3 py-2.5 text-xs leading-5 text-muted-foreground shadow-[0_12px_32px_rgb(0_0_0_/_0.45)] backdrop-blur"
                >
                  {CLIPBOARD_PRIVACY_HINT}
                </div>
              </details>
              <input
                value={input}
                onChange={(event) => updateInput(event.target.value)}
                disabled={!hasAcceptedUsage}
                className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                placeholder={hasAcceptedUsage ? "粘贴抖音或 Bilibili 作品链接。" : "请先勾选使用确认。"}
              />
              {input ? (
                <button
                  type="button"
                  onClick={clearInput}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-amber/[0.12] hover:text-amber active:scale-[0.94]"
                  aria-label="清空链接"
                  title="清空链接"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={detectInput}
              disabled={!hasAcceptedUsage || isResolving || !normalizedInput}
              className="inline-flex h-11 w-full items-center justify-center rounded-md border border-cyan/65 bg-cyan px-4 text-sm font-semibold text-black shadow-lg shadow-cyan/20 transition duration-150 hover:-translate-y-0.5 hover:border-cyan hover:bg-[#67e8f9] hover:shadow-[0_0_0_1px_rgb(34_211_238_/_0.35),0_14px_34px_rgb(34_211_238_/_0.28)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/55 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-0 active:scale-[0.98] disabled:cursor-not-allowed disabled:translate-y-0 disabled:border-transparent disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none md:w-auto"
            >
              {isResolving ? "检测中" : "智能检测"}
            </button>
          </div>
        </div>
        ) : null}

        <section
          className={cn(
            "work-flow-panel shrink-0 rounded-lg border border-white/25 p-0 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.07)]",
            hasVisibleResults ? "min-h-[10.5rem] overflow-hidden" : "overflow-visible",
          )}
        >
          {activeKind ? (
            <div className="relative z-10 px-4 pt-4 sm:px-5 sm:pt-5">
              <div className="flex min-h-[3.25rem] flex-wrap items-start gap-x-2 gap-y-4 text-left text-sm xl:flex-nowrap">
                <dl className="contents">
                  <InfoRow
                    className="w-24 shrink-0"
                    copyable={false}
                    label="作品来源"
                    leading={displayWork ? <SourceIcon source={displayWork.source ?? "douyin"} /> : null}
                    singleLine
                    value={displayWork ? SOURCE_LABELS[displayWork.source ?? "douyin"] : KIND_LABELS[activeKind]}
                  />
                  <InfoRow
                    className="w-40 shrink-0"
                    label="作者"
                    singleLine
                    value={displayWork?.authorName ?? "未识别"}
                    href={displayWork?.authorUrl}
                    leading={cachedAvatar?.errorCode === NETWORK_RETRY_ERROR_CODE ? (
                      <NetworkRetryButton
                        className="size-6 text-amber hover:text-cyan"
                        code={cachedAvatar.errorCode}
                        isRetrying={cachedAvatar.isLoading}
                        onRetry={() => retryAsset(activeWorkKey, "avatar")}
                      />
                    ) : cachedAvatar?.isLoading ? (
                      <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                    ) : (cachedAuthorAvatarUrl ?? displayWork?.authorAvatarUrl) ? (
                      <Image
                        src={cachedAuthorAvatarUrl ?? displayWork!.authorAvatarUrl!}
                        alt=""
                        width={24}
                        height={24}
                        unoptimized
                        className="size-6 shrink-0 rounded-full object-cover"
                      />
                    ) : null}
                  />
                  <InfoRow
                    className="w-48 shrink-0"
                    label="作品链接"
                    value={displayWork?.finalUrl ?? "未识别"}
                    href={displayWork?.finalUrl}
                    singleLine
                  />
                </dl>
                {displayWork ? (
                  <WorkDownloadActions
                    key={`${historyDetail?.record.id ?? activeSession.historyRecordId}:${activeWorkKey}`}
                    cachedAssets={cachedAssets}
                    commentsEnabled={douyinAccountServicesEnabled && displayWork.source !== "bilibili"}
                    historyRecordId={historyDetail?.record.id ?? activeSession.historyRecordId}
                    onRetryAsset={(asset) => retryAsset(activeWorkKey, asset)}
                    work={displayWork}
                  />
                ) : null}
              </div>
              <WorkTitleRow title={displayWork?.caption} />
            </div>
          ) : (
            <div className="relative z-10 px-4 py-8 sm:px-5">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="relative z-10 flex min-h-20 flex-col items-center justify-center gap-2 text-center md:col-span-3">
                  <div className="text-base font-semibold text-foreground">
                    {isResolving ? "正在识别作品" : "等待作品链接"}
                  </div>
                  <p className="mobile-readable max-w-md text-sm leading-6 text-muted-foreground">
                    {isResolving ? "正在识别视频作品。" : "粘贴视频链接后，EchoLens 会自动准备转录流程。"}
                  </p>
                </div>
              </div>
            </div>
          )}

          {!isHistoryMode && error ? (
            <div
              className={cn(
                "relative z-10 flex items-center justify-center gap-2 px-4 py-2 text-center text-sm text-destructive sm:px-5",
                hasVisibleResults ? "mt-5" : "mt-3",
              )}
            >
              <AlertCircle className="size-4 shrink-0" />
              <span>{error}</span>
              <NetworkRetryButton
                code={errorCode}
                isRetrying={isResolving || isTranscribing}
                onRetry={() => (work ? void transcribe() : detectInput())}
              />
            </div>
          ) : null}

          {showTranscribeControls ? (
            <TranscribeControls
              actionBusy={isTranscribing}
              actionDisabled={!canUseTranscribeAction}
              actionLabel={transcribeActionLabel}
              configSlot={
                activeKind === "video" && supportsAsrEnhancementOptions && specialWordFilterEnabled && specialWordFilterPanelOpen ? (
                  <SpecialWordFilterPanel
                    disabled={isTranscribing}
                    emptyFilterWords={emptyFilterWords}
                    onEmptyFilterWordsChange={setEmptyFilterWords}
                    onClose={() => setSpecialWordFilterPanelOpen(false)}
                    onSignedFilterWordsChange={setSignedFilterWords}
                    onSystemReservedFilterChange={setSystemReservedFilter}
                    signedFilterWords={signedFilterWords}
                    systemReservedFilter={systemReservedFilter}
                  />
                ) : undefined
              }
              notice={
                activeKind === "video" ? (
                  <>
                    {!isOriginalAudioReady || resourceCacheError ? (
                      <AudioCacheNotice
                        key={activeWorkKey}
                        error={resourceCacheError}
                        errorCode={resourceCacheErrorCode}
                        isLoading={isOriginalAudioPreparing || isFailedAssetRetrying}
                        onRetry={() => retryWork(activeWorkKey)}
                        progressKey={activeWorkKey}
                        videoDurationSeconds={displayWork?.durationSeconds}
                      />
                    ) : null}
                    {isTranscribing || hasPendingTranscribeJob ? (
                      <p className="mt-2 text-center text-xs text-muted-foreground">
                        <LoadingText>
                          {transcribeStatusMessage || "转录任务处理中，完成后会自动展示结果..."}
                        </LoadingText>
                      </p>
                    ) : null}
                  </>
                ) : undefined
              }
              actionSlot={
                activeKind === "video" && supportsAsrEnhancementOptions ? (
                  <SpeakerDiarizationSwitch
                    checked={speakerDiarizationEnabled}
                    disabled={isTranscribing}
                    hasValidSpeakerCount={hasValidSpeakerCount}
                    onCheckedChange={setSpeakerDiarizationEnabled}
                    onSpeakerCountChange={setSpeakerCount}
                    onSpecialWordFilterCheckedChange={updateSpecialWordFilterEnabled}
                    onSpecialWordFilterPanelOpen={() => setSpecialWordFilterPanelOpen(true)}
                    speakerCount={speakerCount}
                    specialWordFilterEnabled={specialWordFilterEnabled}
                    supportsEnhancementOptions={supportsAsrEnhancementOptions}
                    supportsSpecialWordFilter={asrModel === "e2"}
                  />
                ) : activeKind === "video" && supportsQwenAsrOptions ? (
                  <QwenAsrItnSwitch
                    checked={qwenAsrItnEnabled}
                    disabled={isTranscribing}
                    onCheckedChange={setQwenAsrItnEnabled}
                  />
                ) : undefined
              }
              modelSlot={
                activeKind === "video" ? (
                  <AsrModelSelect
                    disabled={isTranscribing}
                    model={asrModel}
                    onChange={updateAsrModel}
                  />
                ) : undefined
              }
              quotaSlot={
                currentUser ? <AsrQuotaIndicator quota={asrQuota} /> : undefined
              }
              onAction={activeKind === "video" ? transcribe : undefined}
            />
          ) : null}
        </section>

        {historyDetail && hasVisibleResults ? (
          <section
            className="rounded-lg border border-white/25 p-0 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.07)]"
          >
            <div className="grid gap-5">
              {visibleResults.map((result) => (
                <ResultBlock
                  history={{
                    onSummaryDeleted: removeHistorySummary,
                    onSummarySaved: addHistorySummary,
                    onTranscriptSaved: updateHistoryTranscript,
                    recordId: historyDetail.record.id,
                    summaries: historyDetail.summaries,
                  }}
                  key={`${historyDetail.record.id}:${result.feature}`}
                  onAuthRequired={redirectToLogin}
                  result={result}
                />
              ))}
            </div>
          </section>
        ) : null}

        {Object.values(workflowSessions).map((session) => {
          const sessionResults = session.results.filter((result) => result.feature === TRANSCRIPT_FEATURE);
          if (sessionResults.length === 0) {
            return null;
          }
          const liveSession = liveTranscribeSessions[session.historyRecordId];
          return (
            <section
              className={cn(
                "rounded-lg border border-white/25 p-0 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.07)]",
                historyDetail || session.historyRecordId !== activeSessionId ? "hidden" : "",
              )}
              key={session.historyRecordId}
            >
              <div className="grid gap-5">
                {sessionResults.map((result) => (
                  <ResultBlock
                    history={liveSession?.persisted ? {
                      onSummaryDeleted: removeHistorySummary,
                      onSummarySaved: addHistorySummary,
                      onTranscriptSaved: (input) => updateHistoryTranscript(input, session.historyRecordId),
                      recordId: session.historyRecordId,
                      summaries: liveHistorySummariesByRecordId[session.historyRecordId] ?? [],
                    } : undefined}
                    key={`${session.historyRecordId}:${result.feature}`}
                    onAuthRequired={redirectToLogin}
                    onSessionActivityChange={setWorkflowSessionResultProcessing}
                    result={result}
                    sessionId={session.historyRecordId}
                  />
                ))}
              </div>
            </section>
          );
        })}

        <LegalNoticeFooter />
        </div>
      </div>
    </main>
  );
}

function LegalNoticeFooter() {
  return (
    <footer className="flex flex-wrap items-center justify-center gap-2 px-2 pb-1 text-xs text-muted-foreground sm:gap-x-4">
      <Link className="rounded-sm px-1.5 py-1 transition hover:text-cyan" href="/legal">法律声明</Link>
    </footer>
  );
}

function TopToast({
  message,
  onDismiss,
  tone,
}: {
  message: string;
  onDismiss: () => void;
  tone: "error" | "info";
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(1rem,env(safe-area-inset-top))] z-[60] flex justify-center px-4">
      <div
        className={cn(
          "pointer-events-auto inline-flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-md border px-4 py-3 text-center text-sm shadow-2xl backdrop-blur-xl motion-safe:animate-[toast-enter_180ms_ease-out]",
          tone === "info"
            ? "border-cyan/30 bg-cyan/[0.1] text-cyan shadow-cyan/10"
            : "border-destructive/35 bg-destructive/10 text-red-200 shadow-black/40",
        )}
        role={tone === "error" ? "alert" : "status"}
      >
        {tone === "info" ? (
          <Info className="size-4 shrink-0" aria-hidden="true" />
        ) : (
          <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        )}
        <span className="min-w-0 leading-5">{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded opacity-65 transition hover:bg-white/10 hover:opacity-100 active:scale-[0.96]"
          aria-label="关闭提示"
          title="关闭"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function TranscriptHistorySidebar({
  activeId,
  douyinAccountServicesEnabled,
  isDrawerOpen,
  isLoading,
  isOpen,
  onCloseDrawer,
  onDelete,
  onNew,
  onOpen,
  onOpenInvitation,
  onRename,
  onReturnLive,
  onSearch,
  onToggle,
  onTogglePin,
  entries,
  query,
  showReturnLive,
}: {
  activeId?: string;
  douyinAccountServicesEnabled: boolean;
  entries: SidebarEntry[];
  isDrawerOpen: boolean;
  isLoading: boolean;
  isOpen: boolean;
  onCloseDrawer: () => void;
  onDelete: (entry: SidebarEntry) => void;
  onNew: () => void;
  onOpen: (entry: SidebarEntry) => void;
  onOpenInvitation: () => void;
  onRename: (entry: SidebarEntry, sessionName: string) => void;
  onReturnLive: () => void;
  onSearch: (query: string) => void;
  onToggle: () => void;
  onTogglePin: (entry: SidebarEntry) => void;
  query: string;
  showReturnLive: boolean;
}) {
  const [collapsedSections, toggleSection] = useCollapsedSidebarSections();
  const [groupRecentBySource, setGroupRecentBySource] = useSidebarGroupBySource();
  const pinnedEntries = entries.filter((entry) => entry.isPinned);
  const recentEntries = entries.filter((entry) => !entry.isPinned);
  const douyinRecentEntries = recentEntries.filter((entry) => entry.source === "douyin");
  const bilibiliRecentEntries = recentEntries.filter((entry) => entry.source === "bilibili");
  const sectionProps = {
    activeId,
    collapsedSections,
    onDelete,
    onOpen,
    onRename,
    onToggleSection: toggleSection,
    onTogglePin,
  };
  const content = (
    <div className="flex h-full min-h-0 flex-col px-1.5 py-2">
      <div className="mb-4 flex h-9 items-center justify-between px-1">
        <Image
          src="/echolens-logo.svg"
          alt="EchoLens"
          width={36}
          height={32}
          className="h-8 w-9 object-contain"
        />
        <button
          type="button"
          onClick={onToggle}
          className="hidden size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-cyan md:inline-flex"
          aria-label={isOpen ? "收起侧栏" : "展开侧栏"}
          title={isOpen ? "收起侧栏" : "展开侧栏"}
        >
          <PanelLeft className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onCloseDrawer}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-cyan md:hidden"
          aria-label="关闭转录历史"
          title="关闭"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="grid gap-1">
        {showReturnLive ? (
          <button
            type="button"
            onClick={onReturnLive}
            className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-semibold text-cyan transition hover:text-foreground active:scale-[0.99]"
          >
            <CornerUpLeft className="size-4 shrink-0" aria-hidden="true" />
            返回当前转录
          </button>
        ) : null}
        <button
          type="button"
          onClick={onNew}
          className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-semibold text-foreground transition hover:bg-white/[0.08] active:scale-[0.99]"
        >
          <SquarePen className="size-4 shrink-0 text-cyan" aria-hidden="true" />
          新建转录
        </button>
        <label className="flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-foreground transition focus-within:bg-white/[0.08] hover:bg-white/[0.08]">
          <Search className="size-4 shrink-0 text-cyan" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => onSearch(event.target.value)}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            placeholder="搜索历史"
          />
        </label>
      </div>
      {douyinAccountServicesEnabled ? (
        <div className="mt-4 border-t border-white/10 pt-2">
          <Link
            href="/douyin/favorites"
            prefetch={false}
            className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] font-semibold text-foreground transition hover:bg-white/[0.08] active:scale-[0.99]"
          >
            <Star className="size-4 shrink-0 text-amber" aria-hidden="true" />
            收藏与关注
          </Link>
        </div>
      ) : null}
      <div className="content-scroll mt-5 min-h-0 flex-1 overflow-auto pb-3">
        {isLoading ? (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-cyan" />
            加载中
          </div>
        ) : null}
        {pinnedEntries.length ? (
          <SidebarSection {...sectionProps} entries={pinnedEntries} section="pinned" title="置顶" />
        ) : null}
        <SidebarSection
          {...sectionProps}
          action={<RecentGroupingMenu grouped={groupRecentBySource} onGroupedChange={setGroupRecentBySource} />}
          entries={recentEntries}
          section="recent"
          title="最近"
        >
          {groupRecentBySource ? (
            <div className="mt-1">
              <SidebarSection
                {...sectionProps}
                entries={douyinRecentEntries}
                leading={<SourceIcon source="douyin" className="size-4 rounded-sm" />}
                section="recent-douyin"
                title="抖音"
              />
              <SidebarSection
                {...sectionProps}
                entries={bilibiliRecentEntries}
                leading={<SourceIcon source="bilibili" className="size-4 rounded-sm" />}
                section="recent-bilibili"
                title="Bilibili"
              />
            </div>
          ) : null}
        </SidebarSection>
        {!isLoading && entries.length === 0 ? (
          <div className="px-2 py-10 text-center text-xs leading-5 text-muted-foreground">暂无转录历史</div>
        ) : null}
      </div>
      <div className="border-t border-white/8 pt-2">
        <button
          type="button"
          onClick={onOpenInvitation}
          className="group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-xs font-medium text-muted-foreground transition duration-150 hover:bg-cyan/[0.08] hover:text-cyan focus-visible:bg-cyan/[0.08] focus-visible:text-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/35 active:scale-[0.98] active:bg-cyan/[0.12]"
        >
          <KeyRound className="size-3.5 shrink-0 transition-transform duration-150 group-hover:-rotate-12 group-hover:scale-110" aria-hidden="true" />
          输入邀请码
        </button>
      </div>
    </div>
  );

  return (
    <>
      <aside
        className={cn(
          "hidden h-full shrink-0 border-r border-white/10 bg-background/90 backdrop-blur md:block",
          isOpen ? "w-52" : "w-12",
        )}
      >
        {isOpen ? content : (
          <div className="flex h-full w-full flex-col items-center gap-2.5 py-2">
            <button
              type="button"
              onClick={onToggle}
              className="inline-flex size-8 items-center justify-center rounded-md text-foreground transition hover:bg-white/10 hover:text-cyan"
              aria-label="展开侧栏"
              title="展开侧栏"
            >
              <PanelLeft className="size-4" aria-hidden="true" />
            </button>
            {showReturnLive ? (
              <button
                type="button"
                onClick={onReturnLive}
                className="inline-flex size-8 items-center justify-center rounded-md text-cyan transition hover:text-foreground"
                aria-label="返回当前转录"
                title="返回当前转录"
              >
                <CornerUpLeft className="size-4" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onNew}
              className="inline-flex size-8 items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.1]"
              aria-label="新建转录"
              title="新建转录"
            >
              <SquarePen className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onToggle}
              className="inline-flex size-8 items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.1]"
              aria-label="搜索历史"
              title="搜索历史"
            >
              <Search className="size-4" aria-hidden="true" />
            </button>
            {douyinAccountServicesEnabled ? (
              <Link
                href="/douyin/favorites"
                prefetch={false}
                className="mt-1 inline-flex size-8 items-center justify-center rounded-md text-amber transition hover:bg-amber/[0.1]"
                aria-label="收藏与关注"
                title="收藏与关注"
              >
                <Star className="size-4" aria-hidden="true" />
              </Link>
            ) : null}
            <button
              type="button"
              onClick={onOpenInvitation}
              className="group mt-auto inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition duration-150 hover:bg-cyan/[0.1] hover:text-cyan focus-visible:bg-cyan/[0.1] focus-visible:text-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/35 active:scale-90"
              aria-label="输入邀请码"
              title="输入邀请码"
            >
              <KeyRound className="size-4 transition-transform duration-150 group-hover:-rotate-12 group-hover:scale-110" aria-hidden="true" />
            </button>
          </div>
        )}
      </aside>
      {isDrawerOpen ? (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm md:hidden">
          <aside className="h-full w-[min(19rem,86vw)] border-r border-white/12 bg-background shadow-2xl shadow-black/50">
            {content}
          </aside>
        </div>
      ) : null}
    </>
  );
}

const SIDEBAR_COLLAPSED_SECTIONS_KEY = "echolens.sidebar.collapsed-sections";
const SIDEBAR_COLLAPSED_SECTIONS_EVENT = "echolens:sidebar-sections";

function subscribeCollapsedSidebarSections(onStoreChange: () => void): () => void {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(SIDEBAR_COLLAPSED_SECTIONS_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(SIDEBAR_COLLAPSED_SECTIONS_EVENT, onStoreChange);
  };
}

function useCollapsedSidebarSections(): [ReadonlySet<string>, (section: string) => void] {
  const stored = useSyncExternalStore(
    subscribeCollapsedSidebarSections,
    () => window.localStorage.getItem(SIDEBAR_COLLAPSED_SECTIONS_KEY) ?? "",
    () => "",
  );
  const collapsed = useMemo(() => new Set(stored.split(",").filter(Boolean)), [stored]);

  const toggle = useCallback((section: string) => {
    const next = new Set(collapsed);
    if (!next.delete(section)) next.add(section);
    window.localStorage.setItem(SIDEBAR_COLLAPSED_SECTIONS_KEY, [...next].join(","));
    window.dispatchEvent(new Event(SIDEBAR_COLLAPSED_SECTIONS_EVENT));
  }, [collapsed]);

  return [collapsed, toggle];
}

const SIDEBAR_GROUP_BY_SOURCE_KEY = "echolens.sidebar.group-by-source";
const SIDEBAR_GROUP_BY_SOURCE_EVENT = "echolens:sidebar-group-by-source";

function useSidebarGroupBySource(): [boolean, (grouped: boolean) => void] {
  const grouped = useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener("storage", onStoreChange);
      window.addEventListener(SIDEBAR_GROUP_BY_SOURCE_EVENT, onStoreChange);
      return () => {
        window.removeEventListener("storage", onStoreChange);
        window.removeEventListener(SIDEBAR_GROUP_BY_SOURCE_EVENT, onStoreChange);
      };
    },
    () => window.localStorage.getItem(SIDEBAR_GROUP_BY_SOURCE_KEY) === "true",
    () => false,
  );
  const setGrouped = useCallback((nextGrouped: boolean) => {
    window.localStorage.setItem(SIDEBAR_GROUP_BY_SOURCE_KEY, String(nextGrouped));
    window.dispatchEvent(new Event(SIDEBAR_GROUP_BY_SOURCE_EVENT));
  }, []);

  return [grouped, setGrouped];
}

function RecentGroupingMenu({
  grouped,
  onGroupedChange,
}: {
  grouped: boolean;
  onGroupedChange: (grouped: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState({ left: 0, top: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node
        && !menuRef.current?.contains(event.target)
        && !panelRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    function updatePanelPosition() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      setPanelPosition({
        left: Math.max(8, Math.min(rect.right + 6, window.innerWidth - 168)),
        top: Math.min(rect.bottom + 6, window.innerHeight - 52),
      });
    }

    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open]);

  const panel = open && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={panelRef}
          className="fixed z-[120] w-40 rounded-lg border border-white/12 bg-background/95 p-1.5 shadow-xl shadow-black/40 backdrop-blur-xl"
          role="menu"
          aria-label="历史分类设置"
          style={panelPosition}
        >
          <div className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-xs text-foreground transition hover:bg-white/[0.06]">
            <span className="whitespace-nowrap">按视频来源分组</span>
            <button
              type="button"
              role="switch"
              aria-checked={grouped}
              aria-label="按视频来源分组"
              onClick={() => onGroupedChange(!grouped)}
              className={cn(
                "relative inline-flex h-4 w-7 shrink-0 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/50",
                grouped ? "bg-cyan" : "bg-white/20",
              )}
            >
              <span
                className={cn(
                  "absolute left-0.5 top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform",
                  grouped ? "translate-x-3" : "translate-x-0",
                )}
              />
            </button>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div ref={menuRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground group-hover/section:opacity-100 group-focus-within/section:opacity-100",
          open ? "opacity-100" : "opacity-0",
        )}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="历史分类设置"
        title="历史分类设置"
      >
        <Ellipsis className="size-4" aria-hidden="true" />
      </button>
      {panel}
    </div>
  );
}

function SidebarSection({
  action,
  activeId,
  children,
  collapsedSections,
  entries,
  leading,
  onDelete,
  onOpen,
  onRename,
  onToggleSection,
  onTogglePin,
  section,
  title,
}: {
  action?: ReactNode;
  activeId?: string;
  children?: ReactNode;
  collapsedSections: ReadonlySet<string>;
  entries: SidebarEntry[];
  leading?: ReactNode;
  onDelete: (entry: SidebarEntry) => void;
  onOpen: (entry: SidebarEntry) => void;
  onRename: (entry: SidebarEntry, sessionName: string) => void;
  onToggleSection: (section: string) => void;
  onTogglePin: (entry: SidebarEntry) => void;
  section: string;
  title: string;
}) {
  const isCollapsed = collapsedSections.has(section);

  return (
    <section className="group/section mb-2">
      <div className="flex h-8 items-center rounded-md transition hover:bg-white/[0.08]">
        <button
          type="button"
          onClick={() => onToggleSection(section)}
          className="flex min-w-0 flex-1 items-center rounded-md px-2.5 text-[13px] font-semibold text-foreground"
          aria-expanded={!isCollapsed}
        >
          <span className="flex min-w-0 items-center gap-2">
            {leading}
            <span className="truncate">{title}</span>
          </span>
        </button>
        {action ? <div className="shrink-0">{action}</div> : null}
        <button
          type="button"
          onClick={() => onToggleSection(section)}
          className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `展开${title}` : `收起${title}`}
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", !isCollapsed && "rotate-90")}
            aria-hidden="true"
          />
        </button>
      </div>
      {isCollapsed ? null : (
        <div className="mt-1">
          {children ?? entries.map((entry) => (
            <SidebarEntryItem
              active={entry.id === activeId}
              entry={entry}
              key={entry.id}
              onDelete={() => onDelete(entry)}
              onOpen={() => onOpen(entry)}
              onRename={(sessionName) => onRename(entry, sessionName)}
              onTogglePin={() => onTogglePin(entry)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SidebarEntryItem({
  active,
  entry,
  onDelete,
  onOpen,
  onRename,
  onTogglePin,
}: {
  active: boolean;
  entry: SidebarEntry;
  onDelete: () => void;
  onOpen: () => void;
  onRename: (sessionName: string) => void;
  onTogglePin: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.title);

  function save() {
    const title = draft.trim();
    if (title && title !== entry.title) onRename(title);
    setDraft(title || entry.title);
    setEditing(false);
  }

  function cancelEditing() {
    setDraft(entry.title);
    setEditing(false);
  }

  if (editing) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
        className="mb-1 flex items-center gap-1 rounded-md p-1"
      >
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEditing();
            }
          }}
          className="h-7 min-w-0 flex-1 rounded bg-black/30 px-2 text-[13px] outline-none ring-1 ring-cyan/40"
        />
        <button
          type="button"
          onClick={cancelEditing}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
          aria-label="取消修改历史名称"
          title="取消"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="submit"
          disabled={!draft.trim()}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded text-cyan transition hover:bg-cyan/[0.1] disabled:cursor-not-allowed disabled:text-muted-foreground"
          aria-label="保存历史名称"
          title="保存"
        >
          <Check className="size-3.5" aria-hidden="true" />
        </button>
      </form>
    );
  }

  return (
    <div className={cn(
      "group mb-1 flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 transition",
      active ? "bg-cyan/[0.12] text-cyan" : "text-muted-foreground hover:bg-white/[0.08] hover:text-foreground",
    )}>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-[13px]"
        title={entry.statusMessage ? `${entry.title} - ${entry.statusMessage}` : entry.title}
      >
        {entry.isBusy ? (
          <Loader2 className="mr-2 inline size-3.5 animate-spin text-cyan" aria-hidden="true" />
        ) : null}
        {entry.title}
      </button>
      <div className="flex w-0 shrink-0 items-center overflow-hidden opacity-0 transition-[width,opacity] duration-150 group-hover:w-[5.25rem] group-hover:opacity-100 group-focus-within:w-[5.25rem] group-focus-within:opacity-100">
        <button
          type="button"
          onClick={onTogglePin}
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded transition hover:bg-amber/[0.12] hover:text-amber",
            entry.isPinned ? "text-amber" : "text-muted-foreground",
          )}
          aria-label={entry.isPinned ? "取消置顶" : "置顶会话"}
          title={entry.isPinned ? "取消置顶" : "置顶"}
        >
          <Pin className={cn("size-3.5", entry.isPinned && "fill-current")} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(entry.title);
            setEditing(true);
          }}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-cyan/[0.1] hover:text-cyan"
          aria-label="修改历史名称"
          title="修改名称"
        >
          <PencilLine className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
          aria-label="删除历史记录"
          title="删除"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function TranscribeControls({
  actionBusy,
  actionDisabled,
  actionLabel,
  actionSlot,
  configSlot,
  modelSlot,
  notice,
  onAction,
  quotaSlot,
}: {
  actionBusy: boolean;
  actionDisabled: boolean;
  actionLabel: string;
  actionSlot?: ReactNode;
  configSlot?: ReactNode;
  modelSlot?: ReactNode;
  notice?: ReactNode;
  onAction?: () => void;
  quotaSlot?: ReactNode;
}) {
  const hasConfig = Boolean(configSlot);

  return (
    <div className={cn("empty-result-stage", hasConfig && "empty-result-stage--expanded")}>
      <div className="empty-result-main">
        <p className="animated-gradient-text empty-result-message mobile-readable relative z-10 max-w-[34rem] text-center text-sm font-semibold leading-6">
          使用 Echolens，将视频作品内容即时转化为有用的可视化笔记。
        </p>
        {notice ? <div className="relative z-10 w-full max-w-[34rem]">{notice}</div> : null}
      </div>
      <div className="empty-result-actions relative z-20 grid w-full gap-3">
        {configSlot ? <div className="min-w-0">{configSlot}</div> : null}
        <div className="grid min-w-0 gap-3 md:flex md:flex-nowrap md:items-center md:justify-between">
          <div className="min-w-0 md:flex-1">{actionSlot}</div>
          <div className="grid min-w-0 gap-2 sm:flex sm:items-center sm:justify-end sm:gap-3 md:shrink-0">
            <div className="flex min-w-0 items-center justify-end gap-2 sm:gap-3">
              {quotaSlot ? <div className="shrink-0">{quotaSlot}</div> : null}
              <div className="min-w-0">{modelSlot}</div>
              <button
                type="button"
                onClick={() => onAction?.()}
                disabled={actionDisabled || !onAction}
                className={cn(
                  "inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-md border px-4 text-sm font-semibold transition duration-150 active:scale-[0.98] disabled:cursor-not-allowed sm:flex-none",
                  actionDisabled || !onAction
                    ? "border-transparent bg-white/[0.055] text-muted-foreground"
                    : "border-cyan/65 bg-cyan text-black shadow-lg shadow-cyan/15 hover:-translate-y-0.5 hover:border-cyan hover:bg-[#67e8f9] hover:shadow-[0_0_0_1px_rgb(34_211_238_/_0.35),0_14px_34px_rgb(34_211_238_/_0.28)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/55 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-0",
                )}
              >
                {actionBusy ? <Square className="size-4 fill-current" aria-hidden="true" /> : null}
                {actionLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SpeakerDiarizationSwitch({
  checked,
  disabled,
  hasValidSpeakerCount,
  onCheckedChange,
  onSpeakerCountChange,
  onSpecialWordFilterCheckedChange,
  onSpecialWordFilterPanelOpen,
  speakerCount,
  specialWordFilterEnabled,
  supportsEnhancementOptions,
  supportsSpecialWordFilter,
}: {
  checked: boolean;
  disabled?: boolean;
  hasValidSpeakerCount: boolean;
  onCheckedChange: (checked: boolean) => void;
  onSpeakerCountChange: (speakerCount: string) => void;
  onSpecialWordFilterCheckedChange: (checked: boolean) => void;
  onSpecialWordFilterPanelOpen: () => void;
  speakerCount: string;
  specialWordFilterEnabled: boolean;
  supportsEnhancementOptions: boolean;
  supportsSpecialWordFilter: boolean;
}) {
  function updateSpeakerCount(value: string) {
    onSpeakerCountChange(value.replace(/\D/gu, ""));
  }

  function stepSpeakerCount(step: -1 | 1) {
    const current = Number(speakerCount);
    const base = Number.isInteger(current) ? current : SPEAKER_COUNT_MIN;
    const next = Math.min(SPEAKER_COUNT_MAX, Math.max(SPEAKER_COUNT_MIN, base + step));
    onSpeakerCountChange(String(next));
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <CompactSwitch
        checked={checked}
        disabled={disabled || !supportsEnhancementOptions}
        label="识别说话人"
        onChange={onCheckedChange}
      />
      {checked && supportsEnhancementOptions ? (
        <label className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-[#9db4d8]">
          <span className="shrink-0">人数</span>
          <span
            className={cn(
              "flex h-6 w-14 overflow-hidden rounded border bg-black/20 transition",
              hasValidSpeakerCount
                ? "border-white/10 focus-within:border-cyan focus-within:ring-2 focus-within:ring-cyan/20"
                : "border-amber/70 focus-within:border-amber focus-within:ring-2 focus-within:ring-amber/20",
            )}
          >
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={speakerCount}
              disabled={disabled}
              onChange={(event) => updateSpeakerCount(event.target.value)}
              placeholder="自动"
              aria-label="说话人人数"
              aria-invalid={!hasValidSpeakerCount}
              title="留空自动识别；填写时请输入 1 到 10 的整数。"
              className="h-full min-w-0 flex-1 bg-transparent px-1 text-xs tabular-nums text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            />
            <span className="flex w-4 shrink-0 flex-col border-l border-white/10">
              <button
                type="button"
                disabled={disabled || speakerCount === String(SPEAKER_COUNT_MAX)}
                onClick={() => stepSpeakerCount(1)}
                className="flex h-3 items-center justify-center text-[#9db4d8] transition hover:bg-cyan/[0.12] hover:text-cyan disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="增加说话人人数"
                title="增加人数"
              >
                <ChevronUp className="size-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={disabled || speakerCount === String(SPEAKER_COUNT_MIN)}
                onClick={() => stepSpeakerCount(-1)}
                className="flex h-3 items-center justify-center border-t border-white/10 text-[#9db4d8] transition hover:bg-cyan/[0.12] hover:text-cyan disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="减少说话人人数"
                title="减少人数"
              >
                <ChevronDown className="size-3" aria-hidden="true" />
              </button>
            </span>
          </span>
        </label>
      ) : null}
      {supportsSpecialWordFilter ? (
        <>
          <CompactSwitch
            checked={specialWordFilterEnabled}
            disabled={disabled}
            label="敏感词过滤"
            onChange={onSpecialWordFilterCheckedChange}
          />
          {specialWordFilterEnabled ? (
            <button
              type="button"
              onClick={onSpecialWordFilterPanelOpen}
              disabled={disabled}
              className="inline-flex h-6 items-center rounded-md px-1.5 text-xs font-medium text-cyan transition hover:bg-cyan/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
            >
              配置
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function QwenAsrItnSwitch({
  checked,
  disabled,
  onCheckedChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <CompactSwitch
        checked={checked}
        disabled={disabled}
        label="逆文本规范化"
        onChange={onCheckedChange}
      />
      <ItnHelpTooltip />
    </div>
  );
}

function ItnHelpTooltip() {
  return (
    <span className="group relative inline-flex shrink-0">
      <button
        type="button"
        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-cyan/[0.08] hover:text-cyan focus-visible:bg-cyan/[0.08] focus-visible:text-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/25"
        aria-label="逆文本规范化说明"
      >
        <AlertCircle className="size-3.5" aria-hidden="true" />
      </button>
      <span className="pointer-events-none absolute bottom-full left-0 z-40 mb-2 hidden w-72 rounded-md border border-white/10 bg-[#0e1420] p-3 text-left text-xs leading-5 text-[#d6e2f5] shadow-xl shadow-black/35 group-focus-within:block group-hover:block">
        <span className="block text-muted-foreground">关闭：今天是二零二六年六月二十九日</span>
        <span className="mt-1 block text-cyan">开启：今天是2026年6月29日</span>
        <span className="mt-2 block text-muted-foreground">
          适合会议、课程、新闻等正式内容；口播娱乐、歌词、方言梗或编号较多时建议关闭，避免数字被误改。
        </span>
      </span>
    </span>
  );
}

function AsrModelSelect({
  disabled,
  model,
  onChange,
}: {
  disabled?: boolean;
  model: AsrModelId;
  onChange: (model: AsrModelId) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = ASR_MODEL_OPTIONS.find((option) => option.id === model) ?? ASR_MODEL_OPTIONS[0];
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  function selectModel(nextModel: AsrModelId) {
    onChange(nextModel);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) {
      return;
    }

    function closeOnOutsidePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    function updatePanelPosition() {
      const button = buttonRef.current;
      const panel = panelRef.current;
      if (!button || !panel) {
        return;
      }

      const buttonRect = button.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const viewportPadding = 8;
      const gap = 8;
      const width = Math.min(ASR_MODEL_PANEL_WIDTH, window.innerWidth - viewportPadding * 2);
      const bottomSpace = window.innerHeight - buttonRect.bottom;
      const topSpace = buttonRect.top;
      const opensBelow = bottomSpace >= panelRect.height + gap || bottomSpace >= topSpace;
      const preferredLeft = buttonRect.right - width;
      const left = Math.min(
        window.innerWidth - viewportPadding - width,
        Math.max(viewportPadding, preferredLeft),
      );
      const preferredTop = opensBelow ? buttonRect.bottom + gap : buttonRect.top - gap - panelRect.height;
      const top = Math.min(
        window.innerHeight - viewportPadding - panelRect.height,
        Math.max(viewportPadding, preferredTop),
      );

      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.width = `${width}px`;
      panel.style.visibility = "visible";
    }

    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open]);

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex h-8 w-[5.8rem] items-center justify-between gap-1.5 rounded-sm bg-transparent px-2 text-sm font-semibold transition",
          selected.id === "e3"
            ? "bg-amber/[0.08] text-amber shadow-[0_0_14px_rgb(245_158_11_/_0.12)] hover:bg-amber/[0.13] hover:text-amber-300"
            : "border border-transparent text-foreground hover:text-cyan",
          disabled && "cursor-not-allowed opacity-50",
        )}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={selected.description}
      >
        <span className="min-w-0 flex-1 truncate">{selected.label}</span>
        <ChevronDown className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              className="z-[120] max-h-[min(16rem,calc(100vh-1rem))] overflow-auto rounded-md bg-[#0e1420] p-1 text-left shadow-2xl shadow-black/40 ring-1 ring-white/8"
              role="listbox"
              style={{ position: "fixed", visibility: "hidden" }}
            >
              {ASR_MODEL_OPTIONS.map((option) => {
                const selectedOption = option.id === model;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => selectModel(option.id)}
                    className={cn(
                      "grid gap-0.5 rounded-md px-2.5 py-1.5 text-left transition",
                      selectedOption
                        ? option.id === "e3"
                          ? "border border-amber/35 bg-amber/[0.12] text-amber"
                          : "border border-cyan/20 bg-cyan/[0.1] text-cyan"
                        : option.id === "e3"
                          ? "border border-transparent text-amber/90 hover:border-amber/25 hover:bg-amber/[0.08]"
                          : "border border-transparent text-foreground hover:bg-white/[0.06]",
                    )}
                    role="option"
                    aria-selected={selectedOption}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold">{option.label}</span>
                      {selectedOption ? <Check className="size-3.5 shrink-0" aria-hidden="true" /> : null}
                    </span>
                    <span className="text-xs leading-5 text-muted-foreground">{option.description}</span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function SpecialWordFilterPanel({
  disabled,
  emptyFilterWords,
  onClose,
  onEmptyFilterWordsChange,
  onSignedFilterWordsChange,
  onSystemReservedFilterChange,
  signedFilterWords,
  systemReservedFilter,
}: {
  disabled?: boolean;
  emptyFilterWords: string;
  onClose: () => void;
  onEmptyFilterWordsChange: (value: string) => void;
  onSignedFilterWordsChange: (value: string) => void;
  onSystemReservedFilterChange: (checked: boolean) => void;
  signedFilterWords: string;
  systemReservedFilter: boolean;
}) {
  return (
    <div className="grid w-full max-w-md min-w-0 gap-2 rounded-md border border-cyan/25 bg-[#101722] p-2 shadow-xl shadow-black/30">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="text-xs font-semibold text-cyan">敏感词过滤配置</span>
        <button
          type="button"
          onClick={onClose}
          disabled={disabled}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-cyan active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="关闭敏感词过滤配置"
          title="关闭"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <SpecialWordTextarea
        disabled={disabled}
        label="替换词"
        onChange={onSignedFilterWordsChange}
        placeholder={'格式：输入需要替换为等长 * 的敏感词，逗号或换行分隔。\n例如 ["测试"]，「帮我测试一下」会变成「帮我**一下」。'}
        value={signedFilterWords}
      />
      <SpecialWordTextarea
        disabled={disabled}
        label="移除词"
        onChange={onEmptyFilterWordsChange}
        placeholder={'格式：输入需要从结果中完全移除的敏感词，逗号或换行分隔。\n例如 ["开始"]，「比赛这就要开始了吗」会变成「比赛这就要了吗」。'}
        value={emptyFilterWords}
      />
      <div className="flex min-w-0">
        <CompactSwitch
          checked={systemReservedFilter}
          disabled={disabled}
          label="是否同时启用系统预置敏感词表（与自定义词表叠加生效）"
          onChange={onSystemReservedFilterChange}
        />
      </div>
    </div>
  );
}

function CompactSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-[#9db4d8] transition",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:text-cyan",
      )}
    >
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
        aria-label={label}
      />
      <span className="min-w-0">{label}</span>
      <span
        aria-hidden="true"
        className={cn(
          "relative h-4 w-8 shrink-0 rounded-full transition peer-focus-visible:ring-2 peer-focus-visible:ring-cyan/30",
          checked ? "bg-cyan/75" : "bg-[#344158]",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 size-3 rounded-full transition",
            checked ? "translate-x-4 bg-black/80" : "translate-x-0 bg-[#1d2738]",
          )}
        />
      </span>
    </label>
  );
}

function SpecialWordTextarea({
  disabled,
  label,
  onChange,
  placeholder,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-xs font-medium text-[#9db4d8]">
      <span>{label}</span>
      <textarea
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        rows={2}
        placeholder={placeholder}
        className="min-h-12 w-full resize-y rounded border border-white/12 bg-[#0b111b] px-2 py-1.5 text-xs leading-5 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-cyan focus:ring-2 focus:ring-cyan/20 disabled:cursor-not-allowed disabled:opacity-60"
      />
    </label>
  );
}

function parseSpecialWordInput(value: string): string[] {
  return [...new Set(
    value
      .split(/[\n,，;；]+/u)
      .map((word) => word.trim())
      .filter(Boolean),
  )];
}

function buildSpecialWordFilterRequest(input: {
  emptyWords: string[];
  signedWords: string[];
  systemReservedFilter: boolean;
}): SpecialWordFilterRequest {
  return {
    ...(input.signedWords.length > 0 ? { filter_with_signed: { word_list: input.signedWords } } : {}),
    ...(input.emptyWords.length > 0 ? { filter_with_empty: { word_list: input.emptyWords } } : {}),
    system_reserved_filter: input.systemReservedFilter,
  };
}

function WorkTitleRow({ title }: { title: string | undefined }) {
  const value = title ?? "未识别";
  const [copied, setCopied] = useState(false);

  async function copyTitle() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="mt-4 min-w-0 border-t border-white/10 pt-3 text-left">
      <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">标题</div>
      <div className="min-w-0 break-words text-sm font-semibold leading-6 text-foreground">
        <span>
          <HighlightedTitle text={value} />
        </span>
        {title ? (
          <button
            type="button"
            onClick={() => void copyTitle()}
            className="ml-1 inline-flex size-5 align-[-3px] items-center justify-center rounded-md text-muted-foreground transition hover:bg-amber/[0.12] hover:text-amber active:scale-[0.94]"
            aria-label={copied ? "已复制标题" : "复制标题"}
            title={copied ? "已复制" : "复制"}
          >
            {copied ? <Check className="size-3.5 text-cyan" /> : <Copy className="size-3.5" />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AudioCacheNotice({
  error,
  errorCode,
  isLoading,
  onRetry,
  progressKey,
  videoDurationSeconds,
}: {
  error: string;
  errorCode?: string;
  isLoading: boolean;
  onRetry: () => void;
  progressKey: string;
  videoDurationSeconds?: number;
}) {
  const estimatedSeconds = estimateMediaProcessingDurationSeconds(videoDurationSeconds);
  const hasEstimatedProgress = isLoading && estimatedSeconds !== null;
  const progress = useEstimatedProgress(hasEstimatedProgress, (estimatedSeconds ?? 0) * 1000, progressKey);
  const message = error || (hasEstimatedProgress && progress >= 99
    ? "原声即将就绪，其他资源将在后台缓存"
    : "正在准备原声，完成后即可转录");

  return (
    <div className="flex w-full justify-center rounded-md px-3 py-2 text-xs font-medium text-muted-foreground">
      <div className="grid w-full max-w-[26rem] gap-2">
        <div className="flex min-w-0 items-center justify-center gap-2">
          {isLoading ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-cyan" aria-hidden="true" />
          ) : (
            <AlertCircle className="size-3.5 shrink-0 text-amber" aria-hidden="true" />
          )}
          <span className="min-w-0 truncate text-center" title={error || undefined}>
            {isLoading && !error ? <LoadingText>{message}</LoadingText> : message}
          </span>
          <NetworkRetryButton
            code={errorCode}
            isRetrying={isLoading}
            onRetry={onRetry}
          />
        </div>
        {hasEstimatedProgress ? (
          <div className="flex w-full items-center gap-2">
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="audio-cache-progress-fill h-full rounded-full bg-cyan shadow-[0_0_12px_rgba(34,211,238,0.35)]"
                style={{
                  "--audio-cache-progress": Math.max(0.01, progress / 100),
                } as CSSProperties}
              />
            </div>
            <span className="w-8 shrink-0 text-right tabular-nums text-cyan">{progress}%</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function useEstimatedProgress(isLoading: boolean, estimatedMs: number, progressKey: string): number {
  const [progress, setProgress] = useState(
    () => (isLoading ? elapsedProgress(readProgressStartedAt(progressKey), estimatedMs) : 0),
  );

  useEffect(() => {
    if (!isLoading) {
      clearProgressStartedAt(progressKey);
      return;
    }

    const startedAt = readProgressStartedAt(progressKey);
    let frameId = 0;
    let displayedProgress = -1;

    const updateProgress = () => {
      const nextProgress = elapsedProgress(startedAt, estimatedMs);

      if (nextProgress !== displayedProgress) {
        displayedProgress = nextProgress;
        setProgress(nextProgress);
      }

      if (nextProgress < 99) {
        frameId = window.requestAnimationFrame(updateProgress);
      }
    };

    frameId = window.requestAnimationFrame(updateProgress);

    return () => window.cancelAnimationFrame(frameId);
  }, [estimatedMs, isLoading, progressKey]);

  return isLoading ? progress : 0;
}

function elapsedProgress(startedAt: number, estimatedMs: number): number {
  const ratio = Math.min(1, (Date.now() - startedAt) / Math.max(1_000, estimatedMs));
  return Math.min(99, Math.max(1, Math.floor(ratio * 99)));
}

function HighlightedTitle({ text }: { text: string }) {
  return renderSocialTokens(text, "title");
}

function InfoRow({
  className,
  copyable = true,
  leading,
  label,
  value,
  singleLine,
  href,
}: {
  className?: string;
  copyable?: boolean;
  leading?: ReactNode;
  label: string;
  value: string;
  singleLine?: boolean;
  href?: string;
}) {
  const isLinked = Boolean(href && value !== "未识别");
  const [copied, setCopied] = useState(false);

  async function copyValue() {
    await navigator.clipboard.writeText(href ?? value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className={cn("min-w-0 text-left", className)}>
      <dt className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-h-8 min-w-0 text-left font-semibold text-foreground">
        <div className="inline-flex max-w-full items-center gap-1.5 align-top">
          {leading}
          {isLinked ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              title={value}
              className="inline-flex min-w-0 max-w-full items-center justify-start gap-1.5 text-cyan underline decoration-cyan/50 underline-offset-4 transition hover:text-amber hover:decoration-amber"
            >
              <span className={cn("min-w-0", singleLine ? "truncate whitespace-nowrap" : "break-words")}>{value}</span>
              <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
            </a>
          ) : (
            <span title={value} className={cn("min-w-0", singleLine ? "truncate whitespace-nowrap" : "break-words")}>
              {value}
            </span>
          )}
          {copyable && value !== "未识别" ? (
            <button
              type="button"
              onClick={() => void copyValue()}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-amber/[0.12] hover:text-amber active:scale-[0.94]"
              aria-label={copied ? `已复制${label}` : `复制${label}`}
              title={copied ? "已复制" : "复制"}
            >
              {copied ? <Check className="size-3.5 text-cyan" /> : <Copy className="size-3.5" />}
            </button>
          ) : null}
        </div>
      </dd>
    </div>
  );
}

function SourceIcon({ className, source }: { className?: string; source: MediaSource }) {
  return (
    <Image
      src={source === "bilibili" ? "https://www.bilibili.com/favicon.ico" : "https://www.douyin.com/favicon.ico"}
      alt=""
      width={24}
      height={24}
      unoptimized
      className={cn("size-6 shrink-0 rounded-md object-contain", className)}
    />
  );
}

type PreparationAssetPayload = AssetPayload & {
  asset: ClientCacheAsset;
  durationSeconds?: number;
  verified?: boolean;
};

type PreparationEvent =
  | { metadata: WorkMetadataPatch; type: "metadata" }
  | { asset: PreparationAssetPayload; type: "asset" }
  | { asset: ClientCacheAsset; error: string; code?: string; type: "asset-error" }
  | { type: "done" }
  | { error: string; code?: string; type: "error" };

function useWorkPreparation(
  works: ResolvedDouyinWork[],
  activeWorkKey: string,
  activeHistoryRecordId: string,
  onMetadata: (workKey: string, metadata: WorkMetadataPatch) => void,
  onAuthRequired: () => void,
): {
  avatar?: CachedMediaAsset;
  avatarUrl?: string;
  cachedAssets: Partial<Record<MediaAssetKind, CachedMediaAsset>>;
  loadingWorkKeys: ReadonlySet<string>;
  retryAsset: (workKey: string, asset: ClientCacheAsset) => void;
  retryWork: (workKey: string) => void;
} {
  const [cachedAssetsByWorkKey, setCachedAssetsByWorkKey] = useState<
    Record<string, Partial<Record<ClientCacheAsset, CachedMediaAsset>>>
  >(() => Object.fromEntries(assetCacheMemory));
  const startedWorkKeysRef = useRef(new Set<string>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const activeWork = useMemo(
    () => works.find((candidate) => getWorkKey(candidate) === activeWorkKey),
    [activeWorkKey, works],
  );
  const preparationKey = `${activeHistoryRecordId}:${activeWorkKey}`;
  const retryAsset = useCallback((workKey: string, assetKind: ClientCacheAsset) => {
    const existing = cachedAssetsByWorkKey[workKey]?.[assetKind];
    const work = works.find((candidate) => getWorkKey(candidate) === workKey);
    if (!activeHistoryRecordId || !work || !existing?.error || existing.url || existing.isLoading) return;

    setCachedAssetsByWorkKey((current) => ({
      ...current,
      [workKey]: {
        ...current[workKey],
        [assetKind]: {
          downloadName: assetKind === "avatar" ? "" : buildCachedAssetFilename(work, assetKind),
          error: existing.error,
          errorCode: existing.errorCode,
          isLoading: true,
          workKey,
        },
      },
    }));

    void fetch(
      `/api/transcript-history/${encodeURIComponent(activeHistoryRecordId)}/assets/${encodeURIComponent(assetKind)}`,
      { cache: "no-store" },
    ).then(async (response) => {
      const payload = await readApiPayload(response, "网络连接失败，请检查网络后重试。") as
        | ApiError
        | { asset: { contentType: string; objectKey: string; url: string; verified?: boolean } };
      if (isUnauthenticatedApiResponse(response, payload)) throw new AuthRequiredError();
      if (!response.ok || !("asset" in payload)) {
        throwApiError(getApiError(payload), "网络连接失败，请检查网络后重试。");
      }
      setCachedAssetsByWorkKey((current) => ({
        ...current,
        [workKey]: {
          ...current[workKey],
          [assetKind]: {
            downloadName: assetKind === "avatar"
              ? ""
              : buildCachedAssetFilename(work, assetKind, payload.asset.contentType),
            isLoading: false,
            objectKey: payload.asset.objectKey,
            url: payload.asset.url,
            verified: assetKind === "originalAudio" ? payload.asset.verified === true : undefined,
            workKey,
          },
        },
      }));
    }).catch((error: unknown) => {
      if (isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      setCachedAssetsByWorkKey((current) => ({
        ...current,
        [workKey]: {
          ...current[workKey],
          [assetKind]: {
            downloadName: assetKind === "avatar" ? "" : buildCachedAssetFilename(work, assetKind),
            error: readUserFacingError(error, "网络连接失败，请检查网络后重试。"),
            errorCode: readUserFacingErrorCode(error),
            isLoading: false,
            workKey,
          },
        },
      }));
    });
  }, [activeHistoryRecordId, cachedAssetsByWorkKey, onAuthRequired, works]);
  const retryWork = useCallback((workKey: string) => {
    for (const [assetKind, asset] of Object.entries(cachedAssetsByWorkKey[workKey] ?? {})) {
      if (asset?.error && !asset.url) retryAsset(workKey, assetKind as ClientCacheAsset);
    }
  }, [cachedAssetsByWorkKey, retryAsset]);

  useEffect(() => {
    for (const [key, assets] of Object.entries(cachedAssetsByWorkKey)) assetCacheMemory.set(key, assets);
  }, [cachedAssetsByWorkKey]);

  useEffect(() => {
    const controllers = controllersRef.current;
    const startedWorkKeys = startedWorkKeysRef.current;
    return () => {
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
      startedWorkKeys.clear();
    };
  }, []);

  useEffect(() => {
    if (!activeWork || startedWorkKeysRef.current.has(preparationKey)) return;
    startedWorkKeysRef.current.add(preparationKey);
    const controller = new AbortController();
    controllersRef.current.set(preparationKey, controller);
    const isBilibili = activeWork.source === "bilibili";
    const assetKinds: ClientCacheAsset[] = isBilibili
      ? ["avatar", "cover", "originalAudio"]
      : ["avatar", "cover", "video", "originalAudio"];

    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setCachedAssetsByWorkKey((current) => ({
        ...current,
        [activeWorkKey]: Object.fromEntries(assetKinds.map((asset) => {
          const existing = current[activeWorkKey]?.[asset];
          return [asset, existing?.url && !existing.error
            ? existing
            : {
                downloadName: asset === "avatar" ? "" : buildCachedAssetFilename(activeWork, asset),
                isLoading: true,
                workKey: activeWorkKey,
              }];
        })),
      }));
    });

    void fetch(`/api/${activeWork.source ?? "douyin"}/prepare`, {
      body: JSON.stringify({
        finalUrl: activeWork.finalUrl,
        historyRecordId: activeHistoryRecordId,
        id: activeWork.id,
        kind: activeWork.kind,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok || !response.body) {
        const payload = await readApiPayload(response, "作品资源准备失败。");
        if (isUnauthenticatedApiResponse(response, payload)) throw new AuthRequiredError();
        throwApiError(getApiError(payload), "作品资源准备失败。");
      }

      for await (const event of readJsonEventStream<PreparationEvent>(response.body)) {
        if (event.type === "metadata") {
          onMetadata(activeWorkKey, event.metadata);
          continue;
        }
        if (event.type === "asset") {
          const asset = event.asset;
          setCachedAssetsByWorkKey((current) => ({
            ...current,
            [activeWorkKey]: {
              ...current[activeWorkKey],
              [asset.asset]: {
                downloadName: asset.asset === "avatar"
                  ? ""
                  : buildCachedAssetFilename(activeWork, asset.asset, asset.contentType),
                isLoading: false,
                objectKey: asset.objectKey,
                url: asset.url,
                verified: asset.asset === "originalAudio" ? asset.verified === true : undefined,
                workKey: activeWorkKey,
              },
            },
          }));
          continue;
        }
        if (event.type === "asset-error") {
          setCachedAssetsByWorkKey((current) => ({
            ...current,
            [activeWorkKey]: {
              ...current[activeWorkKey],
              [event.asset]: {
                downloadName: event.asset === "avatar" ? "" : buildCachedAssetFilename(activeWork, event.asset),
                error: event.error,
                errorCode: event.code,
                isLoading: false,
                workKey: activeWorkKey,
              },
            },
          }));
          continue;
        }
        if (event.type === "error") throw codedError(event.error, event.code);
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      const message = readUserFacingError(error, "作品资源准备失败。");
      setCachedAssetsByWorkKey((current) => ({
        ...current,
        [activeWorkKey]: Object.fromEntries(assetKinds.map((asset) => {
          const existing = current[activeWorkKey]?.[asset];
          return [asset, existing?.url
            ? existing
            : {
                downloadName: asset === "avatar" ? "" : buildCachedAssetFilename(activeWork, asset),
                error: message,
                errorCode: readUserFacingErrorCode(error),
                isLoading: false,
                workKey: activeWorkKey,
              }];
        })),
      }));
    }).finally(() => {
      if (controllersRef.current.get(preparationKey) === controller) {
        controllersRef.current.delete(preparationKey);
      }
    });
  }, [activeHistoryRecordId, activeWork, activeWorkKey, onAuthRequired, onMetadata, preparationKey]);

  const loadingWorkKeys = useMemo(() => new Set(
    Object.entries(cachedAssetsByWorkKey)
      .filter(([, assets]) => Object.values(assets).some((asset) => asset?.isLoading))
      .map(([key]) => key),
  ), [cachedAssetsByWorkKey]);

  return {
    avatar: cachedAssetsByWorkKey[activeWorkKey]?.avatar,
    avatarUrl: cachedAssetsByWorkKey[activeWorkKey]?.avatar?.url,
    cachedAssets: {
      cover: cachedAssetsByWorkKey[activeWorkKey]?.cover,
      originalAudio: cachedAssetsByWorkKey[activeWorkKey]?.originalAudio,
      video: cachedAssetsByWorkKey[activeWorkKey]?.video,
    },
    loadingWorkKeys,
    retryAsset,
    retryWork,
  };
}

type AssetPayload = {
  contentType: string;
  objectKey: string;
  sizeBytes: number;
  url: string;
};

function WorkDownloadActions({
  cachedAssets,
  commentsEnabled,
  historyRecordId,
  onRetryAsset,
  work,
}: {
  cachedAssets: Partial<Record<MediaAssetKind, CachedMediaAsset>>;
  commentsEnabled: boolean;
  historyRecordId: string;
  onRetryAsset: (asset: MediaAssetKind) => void;
  work: ResolvedDouyinWork;
}) {
  const workKey = getWorkKey(work);
  const actions = DOWNLOAD_ACTIONS;
  const [preview, setPreview] = useState<(typeof actions)[number] | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [freshAssetUrls, setFreshAssetUrls] = useState<Partial<Record<MediaAssetKind, string>>>({});
  const [loadingAssets, setLoadingAssets] = useState<ReadonlySet<MediaAssetKind>>(() => new Set());
  const [videoNeedsFetch, setVideoNeedsFetch] = useState(false);

  async function ensureAssetUrl(asset: MediaAssetKind, method: "GET" | "POST" = "GET"): Promise<string> {
    setLoadingAssets((current) => new Set(current).add(asset));
    try {
      const response = await fetch(
        `/api/transcript-history/${encodeURIComponent(historyRecordId)}/assets/${encodeURIComponent(asset)}`,
        { cache: "no-store", method },
      );
      const payload = await readApiPayload(response, "资源准备失败。") as ApiError | { asset: { url: string } };
      if (!response.ok || !("asset" in payload)) {
        throwApiError(getApiError(payload), "资源准备失败。");
      }
      setVideoNeedsFetch(false);
      setFreshAssetUrls((current) => ({ ...current, [asset]: payload.asset.url }));
      return payload.asset.url;
    } finally {
      setLoadingAssets((current) => {
        const next = new Set(current);
        next.delete(asset);
        return next;
      });
    }
  }

  function handleMissingVideo(error: unknown): boolean {
    if (work.source !== "bilibili" || readUserFacingErrorCode(error) !== BILIBILI_VIDEO_CACHE_MISSING_CODE) {
      return false;
    }
    setFreshAssetUrls((current) => {
      const next = { ...current };
      delete next.video;
      return next;
    });
    setVideoNeedsFetch(true);
    setDownloadError("Bilibili 视频缓存不存在或已过期，请点击获取视频资源。");
    return true;
  }

  async function generateBilibiliVideoResource(): Promise<void> {
    setDownloadError("");
    await ensureAssetUrl("video", "POST");
  }

  const previewCache = preview ? cachedAssets[preview.asset] : undefined;
  const previewCached = previewCache?.workKey === workKey ? previewCache : undefined;
  const previewUrl = preview ? freshAssetUrls[preview.asset] ?? previewCached?.url : undefined;

  return (
    <>
      {actions.map((action) => {
        const assetLabel = action.asset === "originalAudio" ? "音频" : action.label.replace("下载", "");
        const previewActionLabel = action.asset === "originalAudio" ? "试听" : "预览";
        const maybeCached = cachedAssets[action.asset];
        const cached = maybeCached?.workKey === workKey ? maybeCached : undefined;
        const isOnDemandBilibiliVideo = work.source === "bilibili" && action.asset === "video";
        const availableUrl = freshAssetUrls[action.asset] ?? cached?.url;
        const isCaching = loadingAssets.has(action.asset) || cached?.isLoading === true || (!cached && !isOnDemandBilibiliVideo);
        const hasCacheError = Boolean(cached?.error && !availableUrl);
        const canRetryCache = hasCacheError && cached?.errorCode === NETWORK_RETRY_ERROR_CODE;
        const cacheTitle = cached?.error ?? (isCaching
          ? "正在准备资源"
          : isOnDemandBilibiliVideo && videoNeedsFetch
            ? "请先获取视频资源"
            : isOnDemandBilibiliVideo && !availableUrl
              ? "点击检查本地视频缓存"
              : action.previewLabel);

        return (
          <div
            key={action.asset}
            className="w-[calc(50%_-_0.625rem)] min-w-32 shrink-0 text-left sm:w-32"
          >
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">{assetLabel}</div>
            <div className="flex min-h-8 min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setDownloadError("");
                  void ensureAssetUrl(action.asset)
                    .then(() => setPreview(action))
                    .catch((error) => {
                      if (!handleMissingVideo(error)) {
                        setDownloadError(readUserFacingError(error, "资源准备失败。"));
                      }
                    });
                }}
                disabled={isCaching || hasCacheError || (isOnDemandBilibiliVideo && videoNeedsFetch)}
                className={cn(
                  "group/preview inline-flex h-8 w-14 shrink-0 items-center justify-center gap-1 rounded-md pl-0 pr-2 text-xs font-semibold text-cyan transition active:scale-[0.99]",
                  isCaching
                    ? "disabled:cursor-wait disabled:opacity-70"
                    : hasCacheError
                      ? "disabled:cursor-not-allowed disabled:opacity-60"
                      : "hover:bg-cyan/[0.08] hover:text-amber",
                )}
                aria-label={action.previewLabel}
                title={cacheTitle}
              >
                {isCaching ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <action.icon className="size-4" aria-hidden="true" />
                )}
                <span className="whitespace-nowrap">{previewActionLabel}</span>
              </button>
              {canRetryCache ? (
                <NetworkRetryButton
                  className="text-amber hover:text-cyan"
                  code={cached?.errorCode}
                  isRetrying={isCaching}
                  onRetry={() => onRetryAsset(action.asset)}
                />
              ) : isOnDemandBilibiliVideo && videoNeedsFetch ? (
                <button
                  type="button"
                  onClick={() => {
                    void generateBilibiliVideoResource()
                      .catch((error) => setDownloadError(readUserFacingError(error, "Bilibili 视频资源获取失败。")));
                  }}
                  disabled={isCaching}
                  className="inline-flex h-7 w-20 shrink-0 items-center justify-center gap-1 rounded-md text-xs font-semibold text-amber transition hover:text-cyan active:scale-[0.96] disabled:cursor-wait disabled:opacity-70"
                  title="获取视频资源并在服务器缓存 2 小时"
                >
                  {isCaching ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Download className="size-3.5" aria-hidden="true" />}
                  获取
                </button>
              ) : isCaching || (!availableUrl && !isOnDemandBilibiliVideo) ? (
                <button
                  type="button"
                  disabled
                  className="inline-flex h-7 w-14 shrink-0 items-center justify-center gap-1 rounded-md text-xs font-semibold text-muted-foreground opacity-60"
                  title="正在准备资源"
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  下载
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setDownloadError("");
                    void ensureAssetUrl(action.asset)
                      .then((url) => downloadCachedAsset(
                        url,
                        cached?.downloadName ?? buildCachedAssetFilename(work, action.asset),
                        work,
                      ))
                      .catch((error) => {
                        if (!handleMissingVideo(error)) {
                          setDownloadError(readUserFacingError(error, "文件保存失败。"));
                        }
                      });
                  }}
                  className="inline-flex h-7 w-14 shrink-0 items-center justify-center gap-1 rounded-md text-xs font-semibold text-cyan transition hover:text-amber active:scale-[0.96]"
                  title={downloadError || action.label}
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  下载
                </button>
              )}
            </div>
          </div>
        );
      })}
      {commentsEnabled ? (
        <CommentActions key={historyRecordId} historyRecordId={historyRecordId} work={work} />
      ) : null}
      {downloadError ? (
        <p className="w-full text-xs font-medium leading-5 text-rose-400" role="alert">
          {downloadError}
        </p>
      ) : null}
      {preview && previewUrl && typeof document !== "undefined"
        ? createPortal(
            <AssetPreviewDialog
              action={preview}
              previewUrl={previewUrl}
              downloadName={previewCached?.downloadName}
              downloadUrl={previewUrl}
              work={work}
              onClose={() => setPreview(null)}
            />,
            document.body,
          )
        : null}
    </>
  );
}

type CommentCollectionEvent =
  | { commentCount: number; page: number; type: "progress" }
  | { type: "done" }
  | { code: string; error: string; type: "error" };

const DOUYIN_CREDENTIAL_ERROR_CODES = new Set([
  "CREDENTIAL_INVALID",
  "CREDENTIAL_MISSING",
  "CREDENTIAL_UNVERIFIED",
]);

type CommentMetadata = {
  collectedAt: number;
  commentCount: number;
};

function CommentActions({
  historyRecordId,
  work,
}: {
  historyRecordId: string;
  work: ResolvedDouyinWork;
}) {
  const [metadata, setMetadata] = useState<CommentMetadata | null>(null);
  const [payload, setPayload] = useState<DouyinCommentsPayload | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [isCollecting, setIsCollecting] = useState(false);
  const [progress, setProgress] = useState({ commentCount: 0, page: 0 });
  const [error, setError] = useState("");
  const endpoint = `/api/transcript-history/${encodeURIComponent(historyRecordId)}/comments`;

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${endpoint}?metadata=1`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const result = await response.json() as { metadata: CommentMetadata | null };
        setMetadata(result.metadata);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [endpoint]);

  async function loadPayload(): Promise<void> {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (response.status === 404) {
      setPayload(null);
      return;
    }
    const result = await readApiPayload(response, "评论加载失败。") as
      | ApiError
      | { payload: DouyinCommentsPayload };
    if (!response.ok || !("payload" in result)) {
      throw new Error(getApiError(result)?.error || "评论加载失败。");
    }
    setPayload(result.payload);
    setMetadata({
      collectedAt: result.payload.collectedAt,
      commentCount: result.payload.commentCount,
    });
  }

  async function openPreview() {
    setPreviewOpen(true);
    setError("");
    if (!payload) {
      try {
        await loadPayload();
      } catch (loadError) {
        setError(readUserFacingError(loadError, "评论加载失败。"));
      }
    }
  }

  async function collectComments() {
    if (isCollecting) return;
    setIsCollecting(true);
    setProgress({ commentCount: 0, page: 0 });
    setError("");
    try {
      const response = await fetch(endpoint, { method: "POST" });
      if (!response.ok || !response.body) {
        const result = await readApiPayload(response, "评论采集失败。") as ApiError;
        const apiError = getApiError(result);
        throw codedError(apiError?.error || "评论采集失败。", apiError?.code);
      }
      for await (const event of readJsonEventStream<CommentCollectionEvent>(response.body)) {
        if (event.type === "progress") {
          setProgress({ commentCount: event.commentCount, page: event.page });
        } else if (event.type === "done") {
          await loadPayload();
        } else if (event.type === "error") {
          throw codedError(event.error, event.code);
        }
      }
    } catch (collectionError) {
      if (DOUYIN_CREDENTIAL_ERROR_CODES.has(readUserFacingErrorCode(collectionError) ?? "")) {
        window.location.assign("/settings?section=douyin");
        return;
      }
      setError(readUserFacingError(collectionError, "评论采集失败。"));
    } finally {
      setIsCollecting(false);
    }
  }

  async function downloadComments() {
    try {
      setError("");
      await downloadCachedAsset(
        `${endpoint}?download=1`,
        `echolens-${work.id}-comments.json`,
        work,
      );
    } catch (downloadError) {
      setError(readUserFacingError(downloadError, "评论文件保存失败。"));
    }
  }

  return (
    <>
      <div className="w-[calc(50%_-_0.625rem)] min-w-32 shrink-0 text-left sm:w-32">
        <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">评论</div>
        <div className="flex min-h-8 min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void openPreview()}
            className="inline-flex h-8 w-14 shrink-0 items-center justify-center gap-1 rounded-md pr-2 text-xs font-semibold text-cyan transition hover:bg-cyan/[0.08] hover:text-amber active:scale-[0.99]"
            aria-label="预览评论"
            title={metadata ? `已采集 ${metadata.commentCount} 条评论` : "预览评论"}
          >
            {isCollecting
              ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              : <MessageCircle className="size-4" aria-hidden="true" />}
            <span>预览</span>
          </button>
          <button
            type="button"
            onClick={() => void downloadComments()}
            disabled={!metadata || isCollecting}
            className="inline-flex h-7 w-14 shrink-0 items-center justify-center gap-1 rounded-md text-xs font-semibold text-cyan transition hover:text-amber active:scale-[0.96] disabled:cursor-not-allowed disabled:text-muted-foreground disabled:opacity-60"
            title={metadata ? "下载评论 JSON" : "请先采集评论"}
          >
            <Download className="size-3.5" aria-hidden="true" />
            下载
          </button>
        </div>
      </div>
      {previewOpen && typeof document !== "undefined"
        ? createPortal(
            <CommentPreviewDialog
              error={error}
              isCollecting={isCollecting}
              metadata={metadata}
              onClose={() => setPreviewOpen(false)}
              onCollect={() => void collectComments()}
              onDownload={() => void downloadComments()}
              payload={payload}
              progress={progress}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function CommentLikeCount({ count }: { count: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground"
      title={`${count} 次点赞`}
    >
      <Heart className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
      <span>{count}</span>
    </span>
  );
}

function CommentPreviewDialog({
  error,
  isCollecting,
  metadata,
  onClose,
  onCollect,
  onDownload,
  payload,
  progress,
}: {
  error: string;
  isCollecting: boolean;
  metadata: CommentMetadata | null;
  onClose: () => void;
  onCollect: () => void;
  onDownload: () => void;
  payload: DouyinCommentsPayload | null;
  progress: { commentCount: number; page: number };
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[140] flex items-end justify-center overflow-hidden bg-[#020409] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:items-center sm:px-4 sm:py-6"
      role="dialog"
      aria-modal="true"
      aria-label="评论预览"
    >
      <div className="flex max-h-[calc(100dvh_-_1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-white/20 bg-background shadow-2xl shadow-black/40 sm:max-h-[calc(100dvh_-_3rem)]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 font-semibold">
            <MessageCircle className="size-4 shrink-0 text-cyan" aria-hidden="true" />
            <span>评论预览</span>
          </div>
          <div className="flex items-center gap-1">
            {metadata ? (
              <button
                type="button"
                onClick={onDownload}
                className="inline-flex size-8 items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.08] hover:text-amber"
                aria-label="下载评论 JSON"
                title="下载评论 JSON"
              >
                <Download className="size-4" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
              aria-label="关闭评论预览"
              title="关闭"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        {error ? <p className="border-b border-white/10 px-4 py-2 text-xs text-rose-400" role="alert">{error}</p> : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {isCollecting ? (
            <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center">
              <Loader2 className="size-7 animate-spin text-cyan" aria-hidden="true" />
              <div className="font-semibold">正在采集评论</div>
              <p className="text-sm text-muted-foreground">
                已处理 {progress.page} 页，采集 {progress.commentCount} 条一级评论
              </p>
            </div>
          ) : payload ? (
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>共 {payload.commentCount} 条一级评论</span>
                <span>采集于 {formatFriendlyDateTime(payload.collectedAt)}</span>
              </div>
              {payload.comments.length > 0 ? (
                <div className="divide-y divide-white/10">
                  {payload.comments.map((comment) => (
                    <article key={comment.id} className="py-3 first:pt-1 last:pb-1">
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="truncate font-semibold text-cyan">{comment.author.name}</span>
                        <CommentLikeCount count={comment.likeCount} />
                      </div>
                      <p className="mt-1.5 whitespace-pre-line break-words text-[13px] leading-5 text-foreground/90">
                        {comment.text || "[无文字内容]"}
                      </p>
                      {comment.replies.length > 0 ? (
                        <div className="mt-2.5 grid gap-1.5 border-l border-cyan/20 pl-3">
                          {comment.replies.map((reply) => (
                            <div key={reply.id} className="bg-white/[0.018] px-2.5 py-1.5">
                              <div className="flex items-center justify-between gap-3 text-xs">
                                <span className="truncate font-medium text-cyan">{reply.author.name}</span>
                                <CommentLikeCount count={reply.likeCount} />
                              </div>
                              <p className="mt-1 whitespace-pre-line break-words text-[13px] leading-5 text-foreground/85">
                                {reply.text || "[无文字内容]"}
                              </p>
                            </div>
                          ))}
                          {comment.replyPageHasMore ? (
                            <p className="pt-0.5 text-[11px] text-muted-foreground">
                              仅展示第一页回复，共 {comment.replyCount} 条
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="flex min-h-44 items-center justify-center text-sm text-muted-foreground">该作品暂无可见评论</div>
              )}
              <button
                type="button"
                onClick={onCollect}
                className="mx-auto mt-2 inline-flex h-9 items-center justify-center rounded-md border border-cyan/40 px-4 text-sm font-semibold text-cyan transition hover:bg-cyan/[0.08]"
              >
                重新采集
              </button>
            </div>
          ) : (
            <div className="flex min-h-52 flex-col items-center justify-center gap-4 text-center">
              <MessageCircle className="size-8 text-muted-foreground" aria-hidden="true" />
              <div className="font-semibold">尚未采集评论</div>
              <button
                type="button"
                onClick={onCollect}
                className="inline-flex h-9 items-center justify-center rounded-md border border-cyan/65 bg-cyan px-4 text-sm font-semibold text-black transition hover:bg-[#67e8f9]"
              >
                采集评论
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function buildCachedAssetFilename(
  work: { id: string },
  asset: MediaAssetKind,
  contentType = "",
): string {
  return `echolens-${work.id}-${asset}.${readCachedAssetExtension(asset, contentType)}`;
}

function readCachedAssetExtension(asset: MediaAssetKind, contentType: string): string {
  if (contentType.includes("webp")) {
    return "webp";
  }
  if (contentType.includes("png")) {
    return "png";
  }
  if (contentType.includes("jpeg") || contentType.includes("jpg")) {
    return "jpg";
  }
  if (contentType.includes("wav")) {
    return "wav";
  }
  if (contentType.includes("mpeg")) {
    return "mp3";
  }
  if (contentType.includes("mp4") && asset === "originalAudio") {
    return "m4a";
  }
  if (contentType.includes("mp4")) {
    return "mp4";
  }

  return asset === "cover" ? "jpg" : asset === "originalAudio" ? "m4a" : "mp4";
}

function AssetPreviewDialog({
  action,
  downloadName,
  previewUrl,
  downloadUrl,
  work,
  onClose,
}: {
  action: (typeof DOWNLOAD_ACTIONS)[number];
  downloadName?: string;
  previewUrl: string;
  downloadUrl: string;
  work: ResolvedDouyinWork;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const canCopyCover = action.asset === "cover";

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  async function copyCover() {
    const absoluteDownloadUrl = new URL(downloadUrl, window.location.origin).toString();
    try {
      const response = await fetch(previewUrl);
      const blob = await response.blob();
      if (blob.type.startsWith("image/") && "ClipboardItem" in window) {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      } else {
        await navigator.clipboard.writeText(absoluteDownloadUrl);
      }
    } catch {
      await navigator.clipboard.writeText(absoluteDownloadUrl);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div
      className="fixed inset-0 z-[140] flex items-end justify-center overflow-hidden bg-[#020409] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:items-center sm:px-4 sm:py-6"
      role="dialog"
      aria-modal="true"
      aria-label={action.previewLabel}
    >
      <div className="max-h-[calc(100dvh_-_1.5rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] w-full max-w-3xl overflow-hidden rounded-lg border border-white/20 bg-background shadow-2xl shadow-black/40 sm:max-h-[calc(100dvh_-_3rem)]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 font-semibold">
            <action.icon className="size-4 shrink-0 text-cyan" aria-hidden="true" />
            <span className="truncate">{action.previewLabel}</span>
          </div>
          <div className="flex items-center gap-1">
            {canCopyCover ? (
              <button
                type="button"
                onClick={() => void copyCover()}
                className="inline-flex size-8 items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.08] hover:text-amber"
                aria-label={copied ? "已复制封面" : "复制封面"}
                title={copied ? "已复制" : "复制封面"}
              >
                {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setDownloadError("");
                void downloadCachedAsset(downloadUrl, downloadName ?? `echolens-${work.id}-${action.asset}`, work)
                  .catch((error) => setDownloadError(readUserFacingError(error, "文件保存失败。")));
              }}
              className="inline-flex size-8 items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.08] hover:text-amber"
              aria-label={action.label}
              title={downloadError || action.label}
            >
              <Download className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
              aria-label="关闭预览"
              title="关闭"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        {downloadError ? (
          <p className="border-b border-white/10 px-4 py-2 text-xs font-medium text-rose-400" role="alert">
            {downloadError}
          </p>
        ) : null}
        <div className="max-h-[calc(100dvh_-_5.5rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] overflow-auto bg-black/25 p-3 sm:max-h-[calc(100dvh_-_7rem)] sm:p-4">
          <AssetPreviewContent asset={action.asset} url={previewUrl} />
        </div>
      </div>
    </div>
  );
}

function AssetPreviewContent({ asset, url }: { asset: MediaAssetKind; url: string }) {
  if (asset === "cover") {
    return <CoverPreview key={url} url={url} />;
  }

  if (asset === "video") {
    return <VideoPreview key={url} url={url} />;
  }

  return <AudioPreview key={url} url={url} />;
}

function CoverPreview({ url }: { url: string }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="relative mx-auto max-w-2xl overflow-hidden rounded-md bg-black/40">
      {!loaded ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/45 backdrop-blur-[2px]">
          <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-cyan" />
            <LoadingText>资源加载中</LoadingText>
          </div>
        </div>
      ) : null}
      <Image
        src={url}
        alt="封面预览"
        width={1200}
        height={675}
        unoptimized
        onLoad={() => setLoaded(true)}
        className={cn("h-auto max-h-[68dvh] w-full object-contain transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
      />
    </div>
  );
}

function VideoPreview({ url }: { url: string }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="relative overflow-hidden rounded-md bg-black/40">
      {!loaded ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/45 backdrop-blur-[2px]">
          <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-cyan" />
            <LoadingText>视频加载中</LoadingText>
          </div>
        </div>
      ) : null}
      <video
        src={url}
        controls
        preload="metadata"
        playsInline
        onLoadedMetadata={() => setLoaded(true)}
        onCanPlay={() => setLoaded(true)}
        className={cn("max-h-[68dvh] w-full rounded-md bg-black transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
      />
    </div>
  );
}

function AudioPreview({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [gain, setGain] = useState(1);

  function syncMetadata() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    setError(null);
    setLoaded(true);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
  }

  function syncTime() {
    setCurrentTime(audioRef.current?.currentTime ?? 0);
  }

  function syncGain() {
    const audio = audioRef.current;
    if (audio?.muted) setGain(0);
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        setError("音频播放失败，请重新打开预览后再试。");
      }
    } else {
      audio.pause();
    }
  }

  function seek(value: string) {
    const audio = audioRef.current;
    if (!audio || !duration) {
      return;
    }
    const nextTime = Number(value);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  function changeGain(value: string) {
    const audio = audioRef.current;
    const nextGain = Math.min(1, Math.max(0, Number(value)));
    setGain(nextGain);
    if (!audio) {
      return;
    }
    audio.volume = nextGain;
    audio.muted = nextGain === 0;
  }

  return (
    <div className="relative rounded-md bg-[linear-gradient(180deg,rgb(255_255_255_/_0.045),rgb(255_255_255_/_0.018))] p-3 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)] sm:p-4">
      {error || !loaded ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-black/45 backdrop-blur-[2px]">
          <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
            {error ? <AlertCircle className="size-4 text-amber" /> : <Loader2 className="size-4 animate-spin text-cyan" />}
            {error ?? <LoadingText>音频加载中</LoadingText>}
          </div>
        </div>
      ) : null}
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        src={url}
        preload="metadata"
        onLoadedMetadata={syncMetadata}
        onCanPlay={syncMetadata}
        onTimeUpdate={syncTime}
        onVolumeChange={syncGain}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setPlaying(false);
          setLoaded(false);
          setError("音频资源加载失败。");
        }}
      />
      <div className={cn("grid min-h-14 gap-3 transition-opacity duration-200 md:grid-cols-[minmax(0,1fr)_12rem] md:items-center", loaded && !error ? "opacity-100" : "opacity-0")}>
        <div className="grid min-w-0 grid-cols-[auto_auto_minmax(8rem,1fr)_auto] items-center gap-2">
          <button
            type="button"
            onClick={() => void togglePlayback()}
            disabled={!loaded || Boolean(error)}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-cyan/10 text-cyan transition hover:bg-cyan/15 hover:text-amber active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={playing ? "暂停音频" : "播放音频"}
            title={playing ? "暂停" : "播放"}
          >
            {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
          </button>
          <span className="shrink-0 text-sm font-medium tabular-nums text-foreground/90">{formatMediaTime(currentTime)}</span>
          <input
            type="range"
            min="0"
            max={duration || 0}
            step="0.01"
            value={duration ? Math.min(currentTime, duration) : 0}
            onChange={(event) => seek(event.currentTarget.value)}
            disabled={!loaded || !duration}
            className="audio-progress h-2 min-w-0 cursor-pointer appearance-none rounded-full bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="音频播放进度"
          />
          <span className="shrink-0 text-right text-sm tabular-nums text-muted-foreground">{formatMediaTime(duration)}</span>
        </div>
        <div className="grid min-w-0 grid-cols-[auto_minmax(5rem,1fr)_2.5rem] items-center gap-2 md:min-w-48">
          <Volume2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={gain}
            onChange={(event) => changeGain(event.currentTarget.value)}
            disabled={!loaded || Boolean(error)}
            className="audio-progress h-2 min-w-0 cursor-pointer appearance-none rounded-full bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="音频音量"
          />
          <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {Math.round(gain * 100)}%
          </span>
        </div>
      </div>
    </div>
  );
}

function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function orderResults(
  results: ExtractionResult[],
  orderedFeatures: ResultFeature[],
): ExtractionResult[] {
  return [...results].sort(
    (first, second) =>
      orderedFeatures.indexOf(first.feature) - orderedFeatures.indexOf(second.feature),
  );
}

function mergeResolvedWork(
  current: ResolvedDouyinWork | null,
  next: ResolvedDouyinWork,
): ResolvedDouyinWork {
  if (!current || current.id !== next.id || current.kind !== next.kind) {
    return next;
  }

  return {
    ...next,
    authorName: next.authorName ?? current.authorName,
    authorAvatarUrl: next.authorAvatarUrl ?? current.authorAvatarUrl,
    authorUrl: next.authorUrl ?? current.authorUrl,
    durationSeconds: next.durationSeconds ?? current.durationSeconds,
  };
}

function ResultBlock({
  history,
  onAuthRequired,
  onSessionActivityChange,
  result,
  sessionId,
}: {
  history?: TranscriptPanelHistory;
  onAuthRequired: () => void;
  onSessionActivityChange?: (sessionId: string, active: boolean) => void;
  result: ExtractionResult;
  sessionId?: string;
}) {
  return (
    <article>
      {result.content ? (
        <TranscriptResultPanel
          history={history}
          onAuthRequired={onAuthRequired}
          onSessionActivityChange={onSessionActivityChange}
          result={result}
          sessionId={sessionId}
        />
      ) : (
        <p className="flex min-h-24 items-center justify-center px-4 py-8 text-center text-sm text-muted-foreground">
          {result.detail ?? "没有返回内容。"}
        </p>
      )}
    </article>
  );
}

type TranscriptPanelHistory = {
  onSummaryDeleted: (recordId: string, summaryId: string) => void;
  onSummarySaved: (recordId: string, summary: TranscriptHistorySummary | undefined) => void;
  onTranscriptSaved: (input: {
    recordId: string;
    transcriptContent: string;
    transcriptSegments: TranscriptSegment[];
  }) => Promise<TranscriptHistoryRecord>;
  recordId: string;
  summaries: TranscriptHistorySummary[];
};

function TranscriptResultPanel({
  history,
  onAuthRequired,
  onSessionActivityChange,
  result,
  sessionId,
}: {
  history?: TranscriptPanelHistory;
  onAuthRequired: () => void;
  onSessionActivityChange?: (sessionId: string, active: boolean) => void;
  result: ExtractionResult;
  sessionId?: string;
}) {
  const initialContent = result.content ?? "";
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [translationOptionsOpen, setTranslationOptionsOpen] = useState(false);
  const [translationSettingsOpen, setTranslationSettingsOpen] = useState(false);
  const [translationTargetRequest, setTranslationTargetRequest] = useState<TranslationTargetRequest | null>(null);
  const [downloadFormat, setDownloadFormat] = useState<TranscriptDownloadFormat>("txt");
  const [viewMode, setViewMode] = useState<TranscriptViewMode>("transcript");
  const [segmentTranslations, setSegmentTranslations] = useState<Record<string, SegmentTranslation>>({});
  const [subtitleTranslations, setSubtitleTranslations] = useState<Record<string, SegmentTranslation>>({});
  const [showTranslationSource, setShowTranslationSource] = useState(true);
  const [translationConfig, setTranslationConfig] = useState<TranslationConfig>(DEFAULT_TRANSLATION_CONFIG);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translationErrorCode, setTranslationErrorCode] = useState<string>();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsCanPersist, setSettingsCanPersist] = useState(false);
  const settingsSaveTimerRef = useRef<number | null>(null);
  const [copyWithSpeaker, setCopyWithSpeaker] = useState(true);
  const [includeSpeakerEmotion, setIncludeSpeakerEmotion] = useState(false);
  const [showSpeaker, setShowSpeaker] = useState(true);
  const [showSpeakerEmotion, setShowSpeakerEmotion] = useState(false);
  const [copyWithTimestamp, setCopyWithTimestamp] = useState(true);
  const [content, setContent] = useState(initialContent);
  const [editedSegments, setEditedSegments] = useState<TranscriptSegment[] | null>(null);
  const [editedSubtitleCues, setEditedSubtitleCues] = useState<SubtitleCue[] | null>(null);
  const [draftSegments, setDraftSegments] = useState<TranscriptSegment[]>([]);
  const [draftSubtitleCues, setDraftSubtitleCues] = useState<SubtitleCue[]>([]);
  const [isEditingContent, setIsEditingContent] = useState(false);
  const [isSavingContent, setIsSavingContent] = useState(false);
  const [contentSaveError, setContentSaveError] = useState("");
  const [editHistory, setEditHistory] = useState<EditHistory>({ future: [], past: [] });
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacementText, setReplacementText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);
  const [summaryMenuOpen, setSummaryMenuOpen] = useState(false);
  const [summaryHistoryOpen, setSummaryHistoryOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [summaryError, setSummaryError] = useState("");
  const [summaryErrorCode, setSummaryErrorCode] = useState<string>();
  const [lastSummaryPrompt, setLastSummaryPrompt] = useState<SummaryPrompt>();
  const [selectedSummaryId, setSelectedSummaryId] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [customPrompts, setCustomPrompts] = useState<CustomSummaryPrompt[]>([]);
  const [customPromptError, setCustomPromptError] = useState("");
  const [deletingSummaryId, setDeletingSummaryId] = useState<string | null>(null);
  const [deletingCustomPromptId, setDeletingCustomPromptId] = useState<string | null>(null);
  const [editingCustomPrompt, setEditingCustomPrompt] = useState<CustomSummaryPrompt | null>(null);
  const [focusedCustomPromptId, setFocusedCustomPromptId] = useState<string | null>(null);
  const [isSavingCustomPrompt, setIsSavingCustomPrompt] = useState(false);
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [customSpeakerIds, setCustomSpeakerIds] = useState<string[]>([]);
  const [segmentSpeakerOverrides, setSegmentSpeakerOverrides] = useState<Record<string, string | undefined>>({});
  const [speakerEditorTarget, setSpeakerEditorTarget] = useState<SpeakerEditorTarget | null>(null);
  const [resultSplitRatio, setResultSplitRatio] = useState(RESULT_SPLIT_DEFAULT_RATIO);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const resultSplitContainerRef = useRef<HTMLDivElement | null>(null);
  const resultSplitRatioRef = useRef(RESULT_SPLIT_DEFAULT_RATIO);
  const resultSplitterRef = useRef<HTMLDivElement | null>(null);
  const splitterDraggingRef = useRef(false);
  const summaryAbortControllerRef = useRef<AbortController | null>(null);
  const summaryHistoryRef = useRef<HTMLDivElement | null>(null);
  const summaryMenuRef = useRef<HTMLDivElement | null>(null);
  const summaryRequestIdRef = useRef(0);
  const summaryScrollRef = useRef<HTMLDivElement | null>(null);
  const latestHistorySummary = history?.summaries[0];

  const applyResultSplitRatio = useCallback((ratio: number) => {
    const clampedRatio = Math.min(RESULT_SPLIT_MAX_RATIO, Math.max(RESULT_SPLIT_MIN_RATIO, ratio));
    resultSplitRatioRef.current = clampedRatio;
    resultSplitContainerRef.current?.style.setProperty("--transcript-pane-ratio", `${clampedRatio}fr`);
    resultSplitContainerRef.current?.style.setProperty("--summary-pane-ratio", `${100 - clampedRatio}fr`);
    resultSplitterRef.current?.setAttribute("aria-valuenow", String(Math.round(clampedRatio)));
  }, []);

  const commitResultSplitRatio = useCallback((ratio: number) => {
    const clampedRatio = Math.min(RESULT_SPLIT_MAX_RATIO, Math.max(RESULT_SPLIT_MIN_RATIO, ratio));
    applyResultSplitRatio(clampedRatio);
    setResultSplitRatio(clampedRatio);
    window.localStorage.setItem(RESULT_SPLIT_STORAGE_KEY, String(clampedRatio));
  }, [applyResultSplitRatio]);

  useLayoutEffect(() => {
    const storedRatio = Number(window.localStorage.getItem(RESULT_SPLIT_STORAGE_KEY));
    if (Number.isFinite(storedRatio) && storedRatio >= RESULT_SPLIT_MIN_RATIO && storedRatio <= RESULT_SPLIT_MAX_RATIO) {
      commitResultSplitRatio(storedRatio);
    }
  }, [commitResultSplitRatio]);

  useEffect(() => () => {
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, []);

  function updateResultSplitFromPointer(clientX: number) {
    const container = resultSplitContainerRef.current;
    if (!container) return;

    const bounds = container.getBoundingClientRect();
    const usableWidth = bounds.width - RESULT_SPLITTER_WIDTH;
    if (usableWidth <= 0) return;

    applyResultSplitRatio(((clientX - bounds.left - RESULT_SPLITTER_WIDTH / 2) / usableWidth) * 100);
  }

  function startResultSplitDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;

    splitterDraggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.dragging = "true";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    updateResultSplitFromPointer(event.clientX);
  }

  function moveResultSplitDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!splitterDraggingRef.current || !event.isPrimary) return;
    updateResultSplitFromPointer(event.clientX);
  }

  function finishResultSplitDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!splitterDraggingRef.current) return;

    splitterDraggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    delete event.currentTarget.dataset.dragging;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    commitResultSplitRatio(resultSplitRatioRef.current);
  }

  function adjustResultSplitWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const nextRatio = event.key === "Home"
      ? RESULT_SPLIT_MIN_RATIO
      : event.key === "End"
        ? RESULT_SPLIT_MAX_RATIO
        : direction
          ? resultSplitRatioRef.current + direction * RESULT_SPLIT_KEYBOARD_STEP * (event.shiftKey ? 2.5 : 1)
          : null;
    if (nextRatio === null) return;

    event.preventDefault();
    commitResultSplitRatio(nextRatio);
  }

  useEffect(() => {
    if (isEditingContent || result.content === undefined) {
      return;
    }
    setContent(result.content);
    setEditedSegments(null);
    setEditedSubtitleCues(null);
  }, [isEditingContent, result.content]);

  useEffect(() => {
    setSummary(latestHistorySummary?.content ?? "");
    setSelectedSummaryId(latestHistorySummary?.id ?? null);
    setSummaryError("");
    setSummaryErrorCode(undefined);
    setSummaryHistoryOpen(false);
  }, [latestHistorySummary?.content, latestHistorySummary?.id]);

  useEffect(() => {
    let isActive = true;

    async function loadCustomPrompts() {
      try {
        const prompts = await fetchCustomSummaryPrompts();
        if (isActive) {
          setCustomPrompts(prompts);
          setCustomPromptError("");
        }
      } catch (error) {
        if (isAuthRequiredError(error)) {
          onAuthRequired();
          return;
        }
        if (isActive) {
          setCustomPromptError(readUserFacingError(error, "自定义提示词加载失败。"));
        }
      }
    }

    void loadCustomPrompts();
    return () => {
      isActive = false;
    };
  }, [onAuthRequired]);

  useEffect(() => {
    return () => {
      abortSummaryRequest();
    };
  }, []);

  const usesOriginalSegments = content === (result.content ?? initialContent);
  const segments = readDisplayTranscriptSegments(content, editedSegments ?? (usesOriginalSegments ? result.transcriptSegments : undefined));
  const canEditSpeakers = segments.some((segment) => Boolean(segment.speakerId));
  const canUseSpeakerEmotion = segments.some((segment) => Boolean(segment.emotion));
  const visibleSegments = isEditingContent ? draftSegments : segments;
  const generatedSubtitleCues = useMemo(() => buildSubtitleCues(segments), [segments]);
  const subtitleCues = editedSubtitleCues ?? generatedSubtitleCues;
  const visibleSubtitleCues = isEditingContent && viewMode === "subtitles" ? draftSubtitleCues : subtitleCues;
  const isSubtitleMode = viewMode === "subtitles";
  const defaultSpeakerIds = useMemo(() => getTranscriptSpeakerIds(segments), [segments]);
  const speakerOptions = useMemo(
    () => buildSpeakerOptions(defaultSpeakerIds, customSpeakerIds, segmentSpeakerOverrides, speakerNames),
    [customSpeakerIds, defaultSpeakerIds, segmentSpeakerOverrides, speakerNames],
  );
  const trimmedSearchQuery = searchQuery.trim();
  const activeSearchQuery = trimmedSearchQuery;
  const activeSourceItems = isSubtitleMode ? subtitleCues : segments;
  const searchableSourceItems = isEditingContent
    ? (isSubtitleMode ? draftSubtitleCues : draftSegments)
    : activeSourceItems;
  const activeTranslations = isSubtitleMode ? subtitleTranslations : segmentTranslations;
  const searchMatches = useMemo(
    () => countSearchMatches(searchableSourceItems.map((item) => item.text).join("\n"), activeSearchQuery),
    [activeSearchQuery, searchableSourceItems],
  );
  const selectedSearchMatchIndex = searchMatches > 0
    ? Math.min(activeSearchMatchIndex, searchMatches - 1)
    : 0;
  const searchMatchRanges = useMemo(
    () => buildSearchMatchRanges(searchableSourceItems, activeSearchQuery),
    [activeSearchQuery, searchableSourceItems],
  );
  const activeSearchSegmentIndex = useMemo(
    () => findSearchMatchSegmentIndex(searchMatchRanges, selectedSearchMatchIndex),
    [searchMatchRanges, selectedSearchMatchIndex],
  );
  const activeSearchContainerRef = useRef<HTMLDivElement | null>(null);
  const activeSearchMatchRef = useRef<HTMLDivElement | null>(null);
  const hasSummaryOutput = isSummarizing || Boolean(summary || summaryError);
  const isTranslationActive = Object.values(segmentTranslations).some((item) => item.isLoading) ||
    Object.values(subtitleTranslations).some((item) => item.isLoading);
  const isSessionActivityActive = isSummarizing || isTranslationActive;

  useEffect(() => {
    if (sessionId) {
      onSessionActivityChange?.(sessionId, isSessionActivityActive);
    }
  }, [isSessionActivityActive, onSessionActivityChange, sessionId]);

  useEffect(() => () => {
    if (sessionId) {
      onSessionActivityChange?.(sessionId, false);
    }
  }, [onSessionActivityChange, sessionId]);

  const isTranslatingAll = activeSourceItems.length > 0
    && activeSourceItems.every((item, index) => activeTranslations[buildTimedTextKey(item, index)]?.isLoading);
  const isSubtitleDownloadFormat = downloadFormat === "srt" || downloadFormat === "vtt";
  const canIncludeSpeaker = canEditSpeakers && !isSubtitleDownloadFormat;
  const canCopySpeaker = canEditSpeakers && !isSubtitleMode;
  const includeSupportedSpeakerEmotion = canUseSpeakerEmotion && includeSpeakerEmotion;
  const showSupportedSpeakerEmotion = canUseSpeakerEmotion && showSpeakerEmotion;

  useLayoutEffect(() => {
    if (!isSummarizing) {
      return;
    }

    const summaryScroll = summaryScrollRef.current;
    if (summaryScroll) {
      summaryScroll.scrollTop = summaryScroll.scrollHeight;
    }
  }, [isSummarizing, summary]);

  useEffect(() => {
    let isActive = true;

    async function loadUserSettings() {
      try {
        const response = await fetch("/api/user/settings", { cache: "no-store" });
        if (!response.ok) {
          if (isActive) {
            setSettingsCanPersist(false);
            setSettingsLoaded(true);
          }
          return;
        }

        const payload = await response.json() as UserSettingsPayload;
        const transcriptSettings = normalizeTranscriptUserSettings(payload.settings?.transcript);
        const translationSettings = normalizeTranslationUserSettings(payload.settings?.translation);
        const downloadOrganization = payload.settings?.download?.organization;
        if (isDownloadOrganization(downloadOrganization)) {
          cacheDownloadOrganization(downloadOrganization);
        }
        if (isActive) {
          setTranslationConfig({
            domains: translationSettings.domains,
            targetLang: translationSettings.targetLang,
            termsText: translationSettings.termsText,
            tmText: translationSettings.tmText,
          });
          setShowTranslationSource(translationSettings.showSource);
          setIncludeSpeakerEmotion(transcriptSettings.includeSpeakerEmotion);
          setShowSpeaker(transcriptSettings.showSpeaker);
          setShowSpeakerEmotion(transcriptSettings.showSpeakerEmotion);
          setSettingsCanPersist(true);
          setSettingsLoaded(true);
        }
      } catch {
        if (isActive) {
          setSettingsCanPersist(false);
          setSettingsLoaded(true);
        }
      }
    }

    void loadUserSettings();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!settingsLoaded || !settingsCanPersist) {
      return;
    }

    if (settingsSaveTimerRef.current !== null) {
      window.clearTimeout(settingsSaveTimerRef.current);
    }

    settingsSaveTimerRef.current = window.setTimeout(() => {
      void Promise.all([
        saveUserSetting("translation", {
          ...translationConfig,
          showSource: showTranslationSource,
        }),
        saveUserSetting("transcript", { includeSpeakerEmotion, showSpeaker, showSpeakerEmotion }),
      ])
        .then(() => setSettingsError(""))
        .catch((error) => setSettingsError(readUserFacingError(error, "设置保存失败。")));
    }, 500);

    return () => {
      if (settingsSaveTimerRef.current !== null) {
        window.clearTimeout(settingsSaveTimerRef.current);
      }
    };
  }, [settingsCanPersist, settingsLoaded, includeSpeakerEmotion, showSpeaker, showSpeakerEmotion, showTranslationSource, translationConfig]);

  useLayoutEffect(() => {
    if (!activeSearchQuery || activeSearchSegmentIndex < 0) {
      return;
    }

    scrollSearchMatchIntoContainer(activeSearchContainerRef.current, activeSearchMatchRef.current);
  }, [activeSearchQuery, activeSearchSegmentIndex, selectedSearchMatchIndex]);

  useEffect(() => {
    if (!copyMenuOpen && !downloadMenuOpen && !summaryMenuOpen && !summaryHistoryOpen && !translationOptionsOpen && !translationSettingsOpen) {
      return;
    }

    function closeActionMenu(event: PointerEvent) {
      if (
        actionMenuRef.current?.contains(event.target as Node) ||
        summaryMenuRef.current?.contains(event.target as Node) ||
        summaryHistoryRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setCopyMenuOpen(false);
      setDownloadMenuOpen(false);
      setSummaryMenuOpen(false);
      setSummaryHistoryOpen(false);
      setTranslationOptionsOpen(false);
      setTranslationSettingsOpen(false);
      setTranslationTargetRequest(null);
    }

    document.addEventListener("pointerdown", closeActionMenu);
    return () => document.removeEventListener("pointerdown", closeActionMenu);
  }, [copyMenuOpen, downloadMenuOpen, summaryHistoryOpen, summaryMenuOpen, translationOptionsOpen, translationSettingsOpen]);

  async function copyAll() {
    const text = isSubtitleMode
      ? buildSubtitleFileContent(subtitleCues, "srt", {
          includeEmotion: includeSupportedSpeakerEmotion,
          includeTimestamp: copyWithTimestamp,
        })
      : buildTranscriptCopyText(segments, {
          includeEmotion: includeSupportedSpeakerEmotion,
          includeSpeaker: canCopySpeaker && copyWithSpeaker,
          includeTimestamp: copyWithTimestamp,
          resolveSpeaker: (segment, index) => {
            const segmentKey = buildTranscriptSegmentKey(segment, index);
            const speakerId = segmentSpeakerOverrides[segmentKey] ?? segment.speakerId;
            return speakerId ? getSpeakerOption(speakerOptions, speakerId).label : "";
          },
        });
    await navigator.clipboard.writeText(text);
    setCopiedAll(true);
    window.setTimeout(() => setCopiedAll(false), 1600);
  }

  function downloadTranscript() {
    const payload = isSubtitleDownloadFormat
      ? buildSubtitleDownloadContent(subtitleCues, downloadFormat, {
          includeEmotion: includeSupportedSpeakerEmotion,
          includeTimestamp: copyWithTimestamp,
        })
      : buildTranscriptDownloadContent(segments, {
          format: downloadFormat,
          includeEmotion: includeSupportedSpeakerEmotion,
          includeSpeaker: canIncludeSpeaker && copyWithSpeaker,
          includeTimestamp: copyWithTimestamp,
          resolveSpeaker: (segment, index) => {
            const segmentKey = buildTranscriptSegmentKey(segment, index);
            const speakerId = segmentSpeakerOverrides[segmentKey] ?? segment.speakerId;
            return speakerId ? getSpeakerOption(speakerOptions, speakerId).label : "";
          },
        });
    downloadTextFile(payload.content, `echolens-${isSubtitleDownloadFormat ? "subtitles" : "transcript"}.${payload.extension}`, payload.mimeType);
    setDownloadMenuOpen(false);
  }

  function changeViewMode(mode: TranscriptViewMode) {
    setViewMode(mode);
    setIsEditingContent(false);
    setDraftSegments([]);
    setDraftSubtitleCues([]);
    setEditHistory({ future: [], past: [] });
    setReplaceOpen(false);
    setCopyMenuOpen(false);
    setDownloadMenuOpen(false);
    setTranslationOptionsOpen(false);
    setTranslationSettingsOpen(false);
    setTranslationTargetRequest(null);
  }

  function openTranslationTargetMenu(request: TranslationTargetRequest) {
    setTranslationTargetRequest(request);
    setTranslationOptionsOpen(true);
    setTranslationSettingsOpen(false);
    setCopyMenuOpen(false);
    setDownloadMenuOpen(false);
  }

  function toggleTranslationSettings() {
    setTranslationSettingsOpen((value) => !value);
    setTranslationOptionsOpen(false);
    setTranslationTargetRequest(null);
    setCopyMenuOpen(false);
    setDownloadMenuOpen(false);
  }

  function translateSelectedTarget(targetLang: string) {
    const request = translationTargetRequest;
    if (!request) {
      return;
    }

    if (request.kind === "all") {
      void translateAll(targetLang);
      return;
    }

    const sourceItems = request.kind === "subtitle" ? subtitleCues : segments;
    const index = sourceItems.findIndex((item, itemIndex) => buildTimedTextKey(item, itemIndex) === request.key);
    if (index >= 0) {
      void translateTimedText(sourceItems[index], index, targetLang);
    }
  }

  async function translateAll(targetLang: string, retryOnlyMissing = false) {
    const streamItems = activeSourceItems.flatMap((item, index) => {
      const key = buildTimedTextKey(item, index);
      return retryOnlyMissing && activeTranslations[key]?.text
        ? []
        : [{ key, text: item.text }];
    });
    if (streamItems.length === 0) {
      setTranslationError(null);
      setTranslationErrorCode(undefined);
      return;
    }
    const options = buildTranslationOptions(translationConfig, targetLang);
    if (!options.ok) {
      setTranslationError(options.error);
      setTranslationErrorCode(undefined);
      return;
    }

    setTranslationConfig((current) => ({ ...current, targetLang }));
    setTranslationError(null);
    setTranslationErrorCode(undefined);
    setTranslationOptionsOpen(false);
    setTranslationTargetRequest(null);
    setCopyMenuOpen(false);
    setDownloadMenuOpen(false);
    const loadingTranslations = Object.fromEntries(streamItems.map((item) => [
      item.key,
      { isLoading: true },
    ]));
    const setTranslations = isSubtitleMode ? setSubtitleTranslations : setSegmentTranslations;
    setTranslations((current) => retryOnlyMissing
      ? { ...current, ...loadingTranslations }
      : loadingTranslations);

    try {
      await streamTranslationContent({
        items: streamItems,
        options: options.value,
        onDelta: (key, delta) => {
          setTranslations((current) => ({
            ...current,
            [key]: {
              isLoading: true,
              text: applyStreamTextEvent(current[key]?.text ?? "", { type: "delta", value: delta }),
            },
          }));
        },
        onReplace: (key) => {
          setTranslations((current) => ({
            ...current,
            [key]: {
              isLoading: true,
              text: applyStreamTextEvent(current[key]?.text ?? "", { type: "replace", value: "" }),
            },
          }));
        },
        onDone: (key, text) => {
          setTranslations((current) => ({
            ...current,
            [key]: { isLoading: false, text },
          }));
        },
        onError: (key, error, code) => {
          setTranslations((current) => ({
            ...current,
            [key]: { error, errorCode: code, isLoading: false },
          }));
        },
      });
    } catch (error) {
      if (isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      setTranslations((current) => Object.fromEntries(
        Object.entries(current).map(([key, value]) => [
          key,
          value.isLoading ? { ...value, isLoading: false } : value,
        ]),
      ));
      setTranslationError(readUserFacingError(error, "翻译失败。"));
      setTranslationErrorCode(readUserFacingErrorCode(error));
    }
  }

  async function translateTimedText(
    item: Pick<TranscriptSegment, "endSeconds" | "startSeconds" | "text">,
    index: number,
    targetLang: string,
  ) {
    const itemKey = buildTimedTextKey(item, index);
    const options = buildTranslationOptions(translationConfig, targetLang);
    if (!options.ok) {
      setTranslationError(options.error);
      setTranslationErrorCode(undefined);
      return;
    }

    setTranslationConfig((current) => ({ ...current, targetLang }));
    setTranslationError(null);
    setTranslationErrorCode(undefined);
    setTranslationOptionsOpen(false);
    setTranslationTargetRequest(null);
    const setTranslations = isSubtitleMode ? setSubtitleTranslations : setSegmentTranslations;
    setTranslations((current) => ({
      ...current,
      [itemKey]: { isLoading: true },
    }));

    try {
      await streamTranslationContent({
        items: [{ key: itemKey, text: item.text }],
        options: options.value,
        onDelta: (key, delta) => {
          setTranslations((current) => ({
            ...current,
            [key]: {
              isLoading: true,
              text: applyStreamTextEvent(current[key]?.text ?? "", { type: "delta", value: delta }),
            },
          }));
        },
        onReplace: (key) => {
          setTranslations((current) => ({
            ...current,
            [key]: {
              isLoading: true,
              text: applyStreamTextEvent(current[key]?.text ?? "", { type: "replace", value: "" }),
            },
          }));
        },
        onDone: (key, text) => {
          setTranslations((current) => ({
            ...current,
            [key]: { isLoading: false, text },
          }));
        },
        onError: (key, error, code) => {
          setTranslations((current) => ({
            ...current,
            [key]: { error, errorCode: code, isLoading: false },
          }));
        },
      });
    } catch (error) {
      if (isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      setTranslations((current) => ({
        ...current,
        [itemKey]: {
          error: readUserFacingError(error, "翻译失败。"),
          errorCode: readUserFacingErrorCode(error),
          isLoading: false,
        },
      }));
    }
  }

  async function copySummary() {
    if (!summary.trim()) {
      return;
    }

    await navigator.clipboard.writeText(summary);
    setCopiedSummary(true);
    window.setTimeout(() => setCopiedSummary(false), 1600);
  }

  function abortSummaryRequest() {
    summaryRequestIdRef.current += 1;
    summaryAbortControllerRef.current?.abort();
    summaryAbortControllerRef.current = null;
  }

  function pauseSummary() {
    abortSummaryRequest();
    setIsSummarizing(false);
    setSummaryError("");
    setSummaryErrorCode(undefined);
    setSummaryMenuOpen(false);
  }

  async function summarize(prompt: SummaryPrompt) {
    if (isSummarizing) {
      pauseSummary();
      return;
    }

    const requestId = summaryRequestIdRef.current + 1;
    const controller = new AbortController();
    const isCurrentSummaryRequest = () =>
      summaryRequestIdRef.current === requestId &&
      summaryAbortControllerRef.current === controller &&
      !controller.signal.aborted;

    summaryRequestIdRef.current = requestId;
    summaryAbortControllerRef.current = controller;
    setSummaryMenuOpen(false);
    setLastSummaryPrompt(prompt);
    setSummary("");
    setSummaryError("");
    setSummaryErrorCode(undefined);
    setSelectedSummaryId(null);
    setIsSummarizing(true);

    try {
      await streamSummaryContent({
        historyRecordId: history?.recordId,
        text: content,
        prompt: prompt.prompt,
        promptId: prompt.id,
        promptTitle: prompt.title,
        signal: controller.signal,
        onDelta: (delta) => {
          if (isCurrentSummaryRequest()) {
            setSummary((current) => applyStreamTextEvent(current, { type: "delta", value: delta }));
          }
        },
        onReplace: () => {
          if (isCurrentSummaryRequest()) {
            setSummary((current) => applyStreamTextEvent(current, { type: "replace", value: "" }));
          }
        },
        onDone: (text, savedSummary) => {
          if (!isCurrentSummaryRequest()) {
            return;
          }
          setSummary(text);
          setSelectedSummaryId(savedSummary?.id ?? null);
          if (history) {
            history.onSummarySaved(history.recordId, savedSummary);
          }
        },
      });
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      if (isCurrentSummaryRequest()) {
        setSummaryError(readUserFacingError(error, "AI处理失败。"));
        setSummaryErrorCode(readUserFacingErrorCode(error));
      }
    } finally {
      if (summaryAbortControllerRef.current === controller) {
        summaryAbortControllerRef.current = null;
        setIsSummarizing(false);
      }
    }
  }

  async function saveCustomPrompt(title: string, prompt: string) {
    setIsSavingCustomPrompt(true);
    setCustomPromptError("");

    try {
      const customPrompt = editingCustomPrompt
        ? await updateCustomSummaryPrompt({ id: editingCustomPrompt.id, prompt, title })
        : await createCustomSummaryPrompt({ prompt, title });
      setCustomPrompts((current) => editingCustomPrompt
        ? current.map((item) => (item.id === customPrompt.id ? customPrompt : item))
        : [...current, customPrompt]);
      setFocusedCustomPromptId(customPrompt.id);
      setSummaryMenuOpen(true);
      setPromptDialogOpen(false);
      setEditingCustomPrompt(null);
    } catch (error) {
      if (isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      setCustomPromptError(readUserFacingError(error, "自定义提示词保存失败。"));
    } finally {
      setIsSavingCustomPrompt(false);
    }
  }

  async function removeCustomPrompt(prompt: CustomSummaryPrompt) {
    if (!window.confirm(`删除自定义提示词“${prompt.title}”？`)) {
      return;
    }

    setDeletingCustomPromptId(prompt.id);
    setCustomPromptError("");
    try {
      await deleteCustomSummaryPrompt(prompt.id);
      setCustomPrompts((current) => current.filter((item) => item.id !== prompt.id));
    } catch (error) {
      if (isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      setCustomPromptError(readUserFacingError(error, "自定义提示词删除失败。"));
    } finally {
      setDeletingCustomPromptId(null);
    }
  }

  async function removeSummary(summaryToDelete: TranscriptHistorySummary) {
    if (!history) {
      return;
    }

    setDeletingSummaryId(summaryToDelete.id);
    setSummaryError("");
    setSummaryErrorCode(undefined);
    try {
      await deleteTranscriptHistorySummary(history.recordId, summaryToDelete.id);
      const nextSummary = history.summaries.find((item) => item.id !== summaryToDelete.id);
      history.onSummaryDeleted(history.recordId, summaryToDelete.id);
      if (selectedSummaryId === summaryToDelete.id) {
        setSummary(nextSummary?.content ?? "");
        setSelectedSummaryId(nextSummary?.id ?? null);
      }
      if (history.summaries.length <= 1) {
        setSummaryHistoryOpen(false);
      }
    } catch (error) {
      if (isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      setSummaryError(readUserFacingError(error, "总结记录删除失败。"));
    } finally {
      setDeletingSummaryId(null);
    }
  }

  function resetSummary() {
    pauseSummary();
    setSummary("");
    setSelectedSummaryId(null);
  }

  function startEditingContent() {
    setContentSaveError("");
    setEditHistory({ future: [], past: [] });
    if (isSubtitleMode) {
      setDraftSubtitleCues(subtitleCues.map((cue) => ({ ...cue })));
    } else {
      setDraftSegments(segments.map((segment) => ({ ...segment })));
    }
    setIsEditingContent(true);
  }

  async function saveContent() {
    if (isSubtitleMode) {
      const nextCues = draftSubtitleCues.map((cue) => ({
        ...cue,
        text: normalizeSubtitleText(cue.text),
      }));
      setEditedSubtitleCues(nextCues);
      setDraftSubtitleCues([]);
      setEditHistory({ future: [], past: [] });
      setReplaceOpen(false);
      setIsEditingContent(false);
      setSubtitleTranslations({});
      setContentSaveError("");
      setTranslationError(null);
    setTranslationErrorCode(undefined);
      return;
    }

    const nextSegments = draftSegments.map((segment) => ({
      ...segment,
      text: segment.text.trim(),
    }));
    const nextContent = nextSegments.map((segment) => segment.text).join("\n");
    setContentSaveError("");
    if (history) {
      setIsSavingContent(true);
      try {
        const savedRecord = await history.onTranscriptSaved({
          recordId: history.recordId,
          transcriptContent: nextContent,
          transcriptSegments: nextSegments,
        });
        setEditedSegments(savedRecord.transcriptSegments ?? nextSegments);
        setContent(savedRecord.transcriptContent);
      } catch (error) {
        if (isAuthRequiredError(error)) {
          onAuthRequired();
          return;
        }
        setContentSaveError(readUserFacingError(error, "转录文本保存失败。"));
        return;
      } finally {
        setIsSavingContent(false);
      }
    } else {
      setEditedSegments(nextSegments);
      setContent(nextContent);
    }
    setDraftSegments([]);
    setEditHistory({ future: [], past: [] });
    setReplaceOpen(false);
    setIsEditingContent(false);
    setSegmentTranslations({});
    setEditedSubtitleCues(null);
    setSubtitleTranslations({});
    setTranslationError(null);
    setTranslationErrorCode(undefined);
    if (!history) {
      resetSummary();
    }
  }

  function cancelEditingContent() {
    setDraftSegments([]);
    setDraftSubtitleCues([]);
    setEditHistory({ future: [], past: [] });
    setReplaceOpen(false);
    setIsEditingContent(false);
    setContentSaveError("");
  }

  function readDraftTexts(): string[] {
    return (isSubtitleMode ? draftSubtitleCues : draftSegments).map((item) => item.text);
  }

  function applyDraftTexts(texts: string[]) {
    if (isSubtitleMode) {
      setDraftSubtitleCues((current) => current.map((cue, index) => ({ ...cue, text: texts[index] ?? cue.text })));
      return;
    }
    setDraftSegments((current) => current.map((segment, index) => ({ ...segment, text: texts[index] ?? segment.text })));
  }

  function commitDraftTexts(nextTexts: string[]) {
    const currentTexts = readDraftTexts();
    if (currentTexts.every((text, index) => text === nextTexts[index])) {
      return;
    }
    setEditHistory((current) => ({
      future: [],
      past: [...current.past.slice(-99), currentTexts],
    }));
    applyDraftTexts(nextTexts);
  }

  function undoContentEdit() {
    const previous = editHistory.past.at(-1);
    if (!previous) {
      return;
    }
    const currentTexts = readDraftTexts();
    setEditHistory({
      future: [currentTexts, ...editHistory.future],
      past: editHistory.past.slice(0, -1),
    });
    applyDraftTexts(previous);
  }

  function redoContentEdit() {
    const next = editHistory.future[0];
    if (!next) {
      return;
    }
    const currentTexts = readDraftTexts();
    setEditHistory({
      future: editHistory.future.slice(1),
      past: [...editHistory.past, currentTexts],
    });
    applyDraftTexts(next);
  }

  function updateDraftSegment(index: number, text: string) {
    const nextTexts = draftSegments.map((segment) => segment.text);
    nextTexts[index] = text;
    commitDraftTexts(nextTexts);
  }

  function updateDraftSubtitleCue(index: number, text: string) {
    const nextTexts = draftSubtitleCues.map((cue) => cue.text);
    nextTexts[index] = text;
    commitDraftTexts(nextTexts);
  }

  function toggleReplace() {
    if (!replaceOpen && !isEditingContent) {
      startEditingContent();
    }
    setReplaceOpen((value) => !value);
  }

  function replaceCurrentSearchMatch() {
    if (!activeSearchQuery || searchMatches < 1) {
      return;
    }
    const itemIndex = findSearchMatchSegmentIndex(searchMatchRanges, selectedSearchMatchIndex);
    if (itemIndex < 0) {
      return;
    }
    const localMatchIndex = selectedSearchMatchIndex - searchMatchRanges[itemIndex].startIndex;
    const nextTexts = readDraftTexts();
    nextTexts[itemIndex] = replaceSearchMatch(
      nextTexts[itemIndex],
      activeSearchQuery,
      replacementText,
      localMatchIndex,
    );
    commitDraftTexts(nextTexts);
  }

  function replaceAllSearchMatches() {
    if (!activeSearchQuery || searchMatches < 1) {
      return;
    }
    commitDraftTexts(readDraftTexts().map((text) => replaceAllSearchMatchesInText(
      text,
      activeSearchQuery,
      replacementText,
    )));
    setActiveSearchMatchIndex(0);
  }

  function updateSearchQuery(value: string) {
    setSearchQuery(value);
    setActiveSearchMatchIndex(0);
  }

  function clearSearchQuery() {
    setSearchQuery("");
    setActiveSearchMatchIndex(0);
  }

  function moveSearchMatch(direction: -1 | 1) {
    if (searchMatches < 1) {
      return;
    }

    setActiveSearchMatchIndex((current) => {
      const currentIndex = Math.min(current, searchMatches - 1);
      return (currentIndex + direction + searchMatches) % searchMatches;
    });
  }

  function renameSpeaker(speakerId: string, label: string) {
    setSpeakerNames((current) => ({
      ...current,
      [speakerId]: label.trim(),
    }));
  }

  function assignSpeaker(segmentKey: string, speakerId: string | undefined) {
    setSegmentSpeakerOverrides((current) => ({
      ...current,
      [segmentKey]: speakerId,
    }));
  }

  function addSpeaker(label: string) {
    const speakerId = nextSpeakerId([...defaultSpeakerIds, ...customSpeakerIds]);
    setCustomSpeakerIds((current) => current.includes(speakerId) ? current : [...current, speakerId]);
    renameSpeaker(speakerId, label || `说话人 ${speakerId}`);
    if (speakerEditorTarget) {
      assignSpeaker(speakerEditorTarget.segmentKey, speakerId);
      setSpeakerEditorTarget({ ...speakerEditorTarget, speakerId });
    }
  }

  function deleteSpeaker(speakerId: string) {
    if (!customSpeakerIds.includes(speakerId)) {
      return;
    }

    setCustomSpeakerIds((current) => current.filter((id) => id !== speakerId));
    setSpeakerNames((current) => {
      const next = { ...current };
      delete next[speakerId];
      return next;
    });
    setSegmentSpeakerOverrides((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([, assignedSpeakerId]) => assignedSpeakerId !== speakerId),
      ),
    );
    if (speakerEditorTarget?.speakerId === speakerId) {
      setSpeakerEditorTarget({ ...speakerEditorTarget, speakerId: undefined });
    }
  }

  return (
    <div
      ref={resultSplitContainerRef}
      className="grid gap-3 lg:grid-cols-[minmax(0,var(--transcript-pane-ratio))_0.75rem_minmax(0,var(--summary-pane-ratio))] lg:gap-0"
      style={{
        "--summary-pane-ratio": `${100 - resultSplitRatio}fr`,
        "--transcript-pane-ratio": `${resultSplitRatio}fr`,
      } as CSSProperties}
    >
      <section className="flex min-w-0 flex-col">
        <div className="grid min-h-[4.25rem] grid-cols-1 items-center gap-2 border-b border-white/10 px-3 py-2 md:grid-cols-[auto_minmax(8rem,1fr)_max-content]">
          <div className="flex min-w-0 items-center gap-1 md:col-start-1 md:row-start-1">
            <TranscriptViewToggle mode={viewMode} onChange={changeViewMode} />
          </div>
          <div className="flex min-w-0 justify-start md:col-span-3 md:row-start-2">
            <TranscriptSearchControl
              activeSearchQuery={activeSearchQuery}
              clearSearchQuery={clearSearchQuery}
              moveSearchMatch={moveSearchMatch}
              replaceAllSearchMatches={replaceAllSearchMatches}
              replaceCurrentSearchMatch={replaceCurrentSearchMatch}
              replaceOpen={replaceOpen}
              replacementText={replacementText}
              searchMatches={searchMatches}
              searchQuery={searchQuery}
              setReplacementText={setReplacementText}
              toggleReplace={toggleReplace}
              updateSearchQuery={updateSearchQuery}
            />
          </div>
          <div ref={actionMenuRef} className="flex min-w-max shrink-0 flex-nowrap items-center justify-start gap-1 md:col-start-3 md:row-start-1 md:justify-end">
            <div className="flex h-8 items-center gap-0.5">
              {isEditingContent ? (
                <>
                  <button
                    type="button"
                    onClick={undoContentEdit}
                    disabled={isSavingContent || editHistory.past.length === 0}
                    className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-cyan/[0.08] hover:text-cyan active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-35"
                    aria-label="撤销编辑"
                    title="撤销编辑"
                  >
                    <Undo2 className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={redoContentEdit}
                    disabled={isSavingContent || editHistory.future.length === 0}
                    className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-cyan/[0.08] hover:text-cyan active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-35"
                    aria-label="重做编辑"
                    title="重做编辑"
                  >
                    <Redo2 className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveContent()}
                    disabled={isSavingContent}
                    className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-semibold text-cyan transition hover:bg-cyan/[0.08] hover:text-amber active:scale-[0.94] disabled:cursor-wait disabled:opacity-60"
                    aria-label="保存编辑"
                    title="保存编辑"
                  >
                    {isSavingContent ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Save className="size-3.5" aria-hidden="true" />
                    )}
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={cancelEditingContent}
                    disabled={isSavingContent}
                    className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-semibold text-muted-foreground transition hover:bg-white/10 hover:text-foreground active:scale-[0.94]"
                    aria-label="取消"
                    title="取消"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={startEditingContent}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-amber/[0.08] hover:text-amber active:scale-[0.94]"
                  aria-label="编辑"
                  title="编辑"
                >
                  <PencilLine className="size-4" aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="relative flex h-8 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => openTranslationTargetMenu({ kind: "all" })}
                  disabled={isTranslatingAll || activeSourceItems.length === 0}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-cyan/[0.1] hover:text-cyan active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-60"
                  aria-label="选择目标语言并翻译全文"
                  aria-expanded={translationOptionsOpen}
                  title="选择目标语言并翻译"
                >
                  {isTranslatingAll ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Languages className="size-4" aria-hidden="true" />
                  )}
                </button>
                {translationOptionsOpen ? (
                  <TranslationTargetMenu
                    selectedTargetLang={translationConfig.targetLang}
                    onTranslate={translateSelectedTarget}
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setCopyMenuOpen((value) => !value);
                    setDownloadMenuOpen(false);
                    setTranslationOptionsOpen(false);
                    setTranslationSettingsOpen(false);
                    setTranslationTargetRequest(null);
                  }}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-amber/[0.12] hover:text-amber active:scale-[0.94]"
                  aria-label={copiedAll ? `已复制${result.label}` : `复制${result.label}`}
                  title={copiedAll ? "已复制" : "复制全文"}
                >
                  {copiedAll ? <Check className="size-4 text-cyan" /> : <Copy className="size-4" />}
                </button>
                {copyMenuOpen ? (
                  <CopyTranscriptMenu
                    canIncludeSpeaker={canCopySpeaker}
                    canIncludeSpeakerEmotion={canUseSpeakerEmotion}
                    copied={copiedAll}
                    includeEmotion={includeSpeakerEmotion}
                    includeSpeaker={copyWithSpeaker}
                    includeTimestamp={copyWithTimestamp}
                    onCopy={() => void copyAll()}
                    onEmotionChange={setIncludeSpeakerEmotion}
                    onSpeakerChange={setCopyWithSpeaker}
                    onTimestampChange={setCopyWithTimestamp}
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setDownloadMenuOpen((value) => !value);
                    setCopyMenuOpen(false);
                    setTranslationOptionsOpen(false);
                    setTranslationSettingsOpen(false);
                    setTranslationTargetRequest(null);
                  }}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-cyan/[0.1] hover:text-cyan active:scale-[0.94]"
                  aria-label="下载转录文本"
                  title="下载"
                >
                  <Download className="size-4" aria-hidden="true" />
                </button>
                {downloadMenuOpen ? (
                  <DownloadTranscriptMenu
                    canIncludeSpeaker={canIncludeSpeaker}
                    canIncludeSpeakerEmotion={canUseSpeakerEmotion}
                    format={downloadFormat}
                    includeEmotion={includeSpeakerEmotion}
                    includeSpeaker={copyWithSpeaker}
                    includeTimestamp={copyWithTimestamp}
                    onDownload={downloadTranscript}
                    onEmotionChange={setIncludeSpeakerEmotion}
                    onFormatChange={setDownloadFormat}
                    onSpeakerChange={setCopyWithSpeaker}
                    onTimestampChange={setCopyWithTimestamp}
                  />
                ) : null}
            </div>
            <div className="relative flex h-8 items-center">
                <button
                  type="button"
                  onClick={toggleTranslationSettings}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-cyan/[0.1] hover:text-cyan active:scale-[0.94]"
                  aria-label="设置"
                  aria-expanded={translationSettingsOpen}
                  title="设置"
                >
                  <Settings className="size-4" aria-hidden="true" />
                </button>
                {translationSettingsOpen ? (
                  <TranslationSettingsMenu
                    canShowSpeaker={canEditSpeakers}
                    canShowSpeakerEmotion={canUseSpeakerEmotion}
                    config={translationConfig}
                    error={settingsError}
                    onClose={() => setTranslationSettingsOpen(false)}
                    onConfigChange={setTranslationConfig}
                    onSpeakerDisplayChange={setShowSpeaker}
                    onSpeakerEmotionDisplayChange={setShowSpeakerEmotion}
                    onSourceDisplayChange={setShowTranslationSource}
                    showSpeaker={showSpeaker}
                    showSpeakerEmotion={showSpeakerEmotion}
                    showSource={showTranslationSource}
                  />
                ) : null}
            </div>
          </div>
        </div>
        <div
          ref={activeSearchContainerRef}
          className={cn(RESULT_PANEL_BODY_CLASS, "space-y-1.5 p-2.5 text-sm leading-6 text-foreground/90")}
        >
          {isSubtitleMode ? (
            visibleSubtitleCues.map((cue, index) => {
              const cueKey = buildTimedTextKey(cue, index);
              return (
              <SubtitleCueCard
                activeSearchMatchIndex={isEditingContent ? -1 : selectedSearchMatchIndex}
                cue={cue}
                innerRef={!isEditingContent && index === activeSearchSegmentIndex ? activeSearchMatchRef : undefined}
                isEditing={isEditingContent}
                key={cueKey}
                onTextChange={(text) => updateDraftSubtitleCue(index, text)}
                onTranslate={() => openTranslationTargetMenu({ key: cueKey, kind: "subtitle" })}
                onRetryTranslation={() => void translateTimedText(cue, index, translationConfig.targetLang)}
                searchMatchStartIndex={isEditingContent ? -1 : searchMatchRanges[index]?.startIndex ?? -1}
                searchQuery={isEditingContent ? undefined : activeSearchQuery}
                showTranslationSource={showTranslationSource}
                translation={isEditingContent ? undefined : subtitleTranslations[cueKey]}
              />
              );
            })
          ) : visibleSegments.map((segment, index) => {
            const segmentKey = buildTranscriptSegmentKey(segment, index);
            const speakerId = segmentSpeakerOverrides[segmentKey] ?? segment.speakerId;

            return (
              <div
                key={segmentKey}
                ref={!isEditingContent && index === activeSearchSegmentIndex ? activeSearchMatchRef : undefined}
              >
                <TranscriptSegmentCard
                  activeSearchMatchIndex={isEditingContent ? -1 : selectedSearchMatchIndex}
                  canEditSpeaker={canEditSpeakers && showSpeaker}
                  isEditing={isEditingContent}
                  onEditSpeaker={() => {
                    if (canEditSpeakers && showSpeaker) {
                      setSpeakerEditorTarget({ segmentKey, speakerId });
                    }
                  }}
                  onTextChange={(text) => updateDraftSegment(index, text)}
                  onTranslate={() => openTranslationTargetMenu({ key: segmentKey, kind: "segment" })}
                  onRetryTranslation={() => void translateTimedText(segment, index, translationConfig.targetLang)}
                  searchMatchStartIndex={isEditingContent ? -1 : searchMatchRanges[index]?.startIndex ?? -1}
                  searchQuery={isEditingContent ? undefined : activeSearchQuery}
                  segment={segment}
                  showSpeakerEmotion={showSupportedSpeakerEmotion}
                  showTranslationSource={showTranslationSource}
                  speaker={showSpeaker && speakerId ? getSpeakerOption(speakerOptions, speakerId) : undefined}
                  translation={isEditingContent ? undefined : segmentTranslations[segmentKey]}
                />
              </div>
            );
          })}
          {contentSaveError ? (
            <div className="px-2.5 py-1 text-xs font-medium text-amber">{contentSaveError}</div>
          ) : null}
          {!isEditingContent && translationError ? (
            <div className="flex items-center gap-2 px-2.5 py-1 text-xs font-medium text-amber">
              <span>{translationError}</span>
              <NetworkRetryButton
                code={translationErrorCode}
                isRetrying={isTranslationActive}
                onRetry={() => void translateAll(translationConfig.targetLang, true)}
              />
            </div>
          ) : null}
        </div>
      </section>

      <div
        ref={resultSplitterRef}
        role="separator"
        tabIndex={0}
        aria-label="调整转录文本与 AI 总结区域宽度"
        aria-orientation="vertical"
        aria-valuemin={RESULT_SPLIT_MIN_RATIO}
        aria-valuemax={RESULT_SPLIT_MAX_RATIO}
        aria-valuenow={Math.round(resultSplitRatio)}
        aria-valuetext={`左侧转录文本占 ${Math.round(resultSplitRatio)}%`}
        className="group relative hidden cursor-col-resize touch-none select-none outline-none lg:block"
        onDoubleClick={() => commitResultSplitRatio(RESULT_SPLIT_DEFAULT_RATIO)}
        onKeyDown={adjustResultSplitWithKeyboard}
        onPointerCancel={finishResultSplitDrag}
        onPointerDown={startResultSplitDrag}
        onPointerMove={moveResultSplitDrag}
        onPointerUp={finishResultSplitDrag}
        title="拖动调整宽度，双击恢复默认比例"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/10 transition-colors group-hover:bg-cyan/60 group-focus-visible:bg-cyan group-data-[dragging=true]:bg-cyan" />
        <span className="absolute left-1/2 top-1/2 flex h-10 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-sm border border-transparent bg-background/70 text-muted-foreground opacity-0 shadow-sm transition group-hover:border-cyan/30 group-hover:text-cyan group-hover:opacity-100 group-focus-visible:border-cyan/40 group-focus-visible:text-cyan group-focus-visible:opacity-100 group-data-[dragging=true]:border-cyan/40 group-data-[dragging=true]:text-cyan group-data-[dragging=true]:opacity-100">
          <GripVertical className="size-3.5" aria-hidden="true" />
        </span>
      </div>

      <section className="flex min-w-0 flex-col rounded-r-md border-y border-r border-cyan/20">
          <div className={cn(
            "flex min-h-[4.25rem] items-center justify-end gap-2 px-3 py-2",
            hasSummaryOutput ? "border-b border-white/10" : "",
          )}>
            <div ref={summaryMenuRef} className="flex items-center gap-1.5">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    if (isSummarizing) {
                      pauseSummary();
                      return;
                    }
                    setSummaryMenuOpen((value) => !value);
                    setCopyMenuOpen(false);
                    setDownloadMenuOpen(false);
                    setTranslationOptionsOpen(false);
                    setTranslationSettingsOpen(false);
                    setTranslationTargetRequest(null);
                  }}
                  className={cn(
                    "group inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-semibold text-cyan transition hover:bg-cyan/[0.1] active:scale-[0.96]",
                    summaryMenuOpen
                      ? "bg-cyan/[0.14] shadow-[0_0_18px_rgb(34_211_238_/_0.12)]"
                      : "",
                  )}
                  aria-expanded={summaryMenuOpen}
                  aria-label={isSummarizing ? "停止AI总结" : "选择总结提示词"}
                  title={isSummarizing ? "停止AI总结" : "选择总结提示词"}
                >
                  {isSummarizing ? (
                    <Square className="size-3.5 fill-current" aria-hidden="true" />
                  ) : (
                    <Sparkles className="size-3.5 transition group-hover:rotate-12 group-hover:scale-110" aria-hidden="true" />
                  )}
                  {isSummarizing ? "停止" : "总结"}
                  {isSummarizing ? (
                    <span className="sr-only">生成中</span>
                  ) : (
                    <ChevronDown className={cn("size-3 transition", summaryMenuOpen ? "rotate-180" : "")} aria-hidden="true" />
                  )}
                </button>
                {summaryMenuOpen && !isSummarizing ? (
                  <SummaryPromptMenu
                    customPrompts={customPrompts}
                    deletingCustomPromptId={deletingCustomPromptId}
                    error={customPromptError}
                    focusedCustomPromptId={focusedCustomPromptId}
                    builtInPrompts={SUMMARY_PROMPTS}
                    onCustomPrompt={() => {
                      setCustomPromptError("");
                      setEditingCustomPrompt(null);
                      setSummaryMenuOpen(false);
                      setPromptDialogOpen(true);
                    }}
                    onDeleteCustomPrompt={(prompt) => void removeCustomPrompt(prompt)}
                    onEditCustomPrompt={(prompt) => {
                      setCustomPromptError("");
                      setEditingCustomPrompt(prompt);
                      setSummaryMenuOpen(false);
                      setPromptDialogOpen(true);
                    }}
                    onSelect={(prompt) => {
                      setFocusedCustomPromptId(null);
                      void summarize(prompt);
                    }}
                  />
                ) : null}
              </div>
              {history?.summaries.length ? (
                <div ref={summaryHistoryRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setSummaryHistoryOpen((open) => !open)}
                    className="inline-flex size-8 items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.1] active:scale-[0.94]"
                    aria-expanded={summaryHistoryOpen}
                    aria-label="查看历史总结"
                    title="历史总结"
                  >
                    <History className="size-4" aria-hidden="true" />
                  </button>
                  {summaryHistoryOpen ? (
                    <SummaryHistoryMenu
                      deletingSummaryId={deletingSummaryId}
                      onDelete={(item) => void removeSummary(item)}
                      summaries={history.summaries}
                      onSelect={(item) => {
                        setSummary(item.content);
                        setSelectedSummaryId(item.id);
                        setSummaryError("");
    setSummaryErrorCode(undefined);
                        setSummaryHistoryOpen(false);
                      }}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          <div
            ref={summaryScrollRef}
            className={cn(RESULT_PANEL_BODY_CLASS, hasSummaryOutput ? "p-3" : "")}
          >
            {hasSummaryOutput ? (
              isSummarizing && !summary ? (
                <div className="flex min-h-[20rem] items-center justify-center gap-2 text-sm leading-7 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin text-cyan" />
                  <LoadingText>正在生成</LoadingText>
                </div>
              ) : (
                <div className="relative min-h-[20rem] p-4 text-sm leading-7 text-foreground/90">
                  {summaryError ? (
                    <div className="flex h-40 items-center justify-center gap-2 text-amber">
                      <AlertCircle className="size-4" />
                      <span>{summaryError}</span>
                      {lastSummaryPrompt ? (
                        <NetworkRetryButton
                          code={summaryErrorCode}
                          isRetrying={isSummarizing}
                          onRetry={() => void summarize(lastSummaryPrompt)}
                        />
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void copySummary()}
                        className="absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-cyan/[0.1] hover:text-cyan active:scale-[0.94]"
                        aria-label={copiedSummary ? "已复制AI结果" : "复制AI结果"}
                        title={copiedSummary ? "已复制" : "复制结果"}
                      >
                        {copiedSummary ? <Check className="size-4 text-cyan" /> : <Copy className="size-4" />}
                      </button>
                      <div className="pr-9">
                        <MarkdownPreview text={summary} />
                        {isSummarizing ? (
                          <span className="ml-0.5 inline-block h-4 w-1 animate-pulse rounded-sm bg-cyan align-[-0.15em]" aria-hidden="true" />
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              )
            ) : (
              <LightRays className="min-h-[20rem]" />
            )}
          </div>
        </section>

      {promptDialogOpen ? (
        <CustomPromptDialog
          error={customPromptError}
          initialPrompt={editingCustomPrompt?.prompt}
          initialTitle={editingCustomPrompt?.title}
          isSaving={isSavingCustomPrompt}
          mode={editingCustomPrompt ? "edit" : "create"}
          onClose={() => {
            setPromptDialogOpen(false);
            setEditingCustomPrompt(null);
          }}
          onSave={(title, prompt) => void saveCustomPrompt(title, prompt)}
        />
      ) : null}
      {canEditSpeakers && speakerEditorTarget ? (
        <SpeakerEditorDialog
          customSpeakerIds={customSpeakerIds}
          onAddSpeaker={addSpeaker}
          onAssignSpeaker={(speakerId) => {
            assignSpeaker(speakerEditorTarget.segmentKey, speakerId);
            setSpeakerEditorTarget({ ...speakerEditorTarget, speakerId });
          }}
          onClose={() => setSpeakerEditorTarget(null)}
          onDeleteSpeaker={deleteSpeaker}
          onRenameSpeaker={renameSpeaker}
          selectedSpeakerId={speakerEditorTarget.speakerId}
          speakers={speakerOptions}
        />
      ) : null}
    </div>
  );
}

function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="summary-markdown">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml>
        {normalizeMarkdownInput(text)}
      </Markdown>
    </div>
  );
}

function normalizeMarkdownInput(text: string): string {
  return text
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/iu, "$1")
    .replace(/\\n/g, "\n");
}

function LightRays({
  blur = 14,
  className,
  color = "rgb(34 211 238)",
  count = 8,
  length = "112%",
  opacity = 0.12,
  speed = 11,
}: {
  blur?: number;
  className?: string;
  color?: string;
  count?: number;
  length?: string;
  opacity?: number;
  speed?: number;
}) {
  return (
    <div
      className={cn("light-rays pointer-events-none relative overflow-hidden", className)}
      style={{
        "--light-rays-blur": `${blur}px`,
        "--light-rays-color": color,
        "--light-rays-count": count,
        "--light-rays-length": length,
        "--light-rays-opacity": opacity,
        "--light-rays-speed": `${speed}s`,
      } as React.CSSProperties}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className="light-rays__beam"
          style={{
            "--light-rays-delay": `${(index * speed) / count * -1}s`,
            "--light-rays-left": `${(index + 0.5) * (100 / count)}%`,
            "--light-rays-rotation": `${-18 + (index % 5) * 9}deg`,
            "--light-rays-scale": `${0.72 + (index % 4) * 0.12}`,
          } as React.CSSProperties}
        />
      ))}
      <span className="light-rays__glow" />
    </div>
  );
}

function TranscriptViewToggle({
  mode,
  onChange,
}: {
  mode: TranscriptViewMode;
  onChange: (mode: TranscriptViewMode) => void;
}) {
  const items: Array<{ label: string; mode: TranscriptViewMode }> = [
    { label: "转录", mode: "transcript" },
    { label: "字幕", mode: "subtitles" },
  ];

  return (
    <div className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-semibold">
      {items.map((item, index) => {
        const active = mode === item.mode;
        return (
          <Fragment key={item.mode}>
            {index > 0 ? <span className="text-muted-foreground/55">/</span> : null}
            <button
              type="button"
              onClick={() => onChange(item.mode)}
              className={cn(
                "inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-1.5 transition active:scale-[0.98]",
                active
                  ? "text-cyan"
                  : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

function TranscriptSearchControl({
  activeSearchQuery,
  clearSearchQuery,
  moveSearchMatch,
  replaceAllSearchMatches,
  replaceCurrentSearchMatch,
  replaceOpen,
  replacementText,
  searchMatches,
  searchQuery,
  setReplacementText,
  toggleReplace,
  updateSearchQuery,
}: {
  activeSearchQuery: string;
  clearSearchQuery: () => void;
  moveSearchMatch: (direction: -1 | 1) => void;
  replaceAllSearchMatches: () => void;
  replaceCurrentSearchMatch: () => void;
  replaceOpen: boolean;
  replacementText: string;
  searchMatches: number;
  searchQuery: string;
  setReplacementText: (value: string) => void;
  toggleReplace: () => void;
  updateSearchQuery: (value: string) => void;
}) {
  const canReplace = Boolean(activeSearchQuery) && searchMatches > 0;

  return (
    <div
      className={cn(
        "flex h-10 w-full min-w-0 items-center transition-[max-width]",
        replaceOpen ? "max-w-[42rem]" : "max-w-[24rem]",
      )}
    >
      <span className="inline-flex h-9 w-10 shrink-0 items-center justify-start pl-1.5 text-cyan" aria-hidden="true">
        <Search className="size-4" />
      </span>
      <span className="h-4 w-px shrink-0 bg-white/10" aria-hidden="true" />
      <label className="min-w-[6rem] flex-1">
        <span className="sr-only">搜索原文</span>
        <input
          value={searchQuery}
          onChange={(event) => updateSearchQuery(event.target.value)}
          className="h-10 w-full bg-transparent px-3 text-xs text-foreground outline-none placeholder:text-muted-foreground"
          placeholder="输入关键词"
          autoFocus
        />
      </label>
      <div className="ml-1 flex shrink-0 items-center gap-px">
        <button
          type="button"
          onClick={clearSearchQuery}
          disabled={!searchQuery}
          className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-white/10 hover:text-foreground active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="清除搜索"
          title="清除搜索"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => moveSearchMatch(-1)}
          disabled={searchMatches < 1}
          className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-cyan/[0.08] hover:text-cyan active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="上一个匹配"
          title="上一个匹配"
        >
          <ChevronUp className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => moveSearchMatch(1)}
          disabled={searchMatches < 1}
          className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-cyan/[0.08] hover:text-cyan active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="下一个匹配"
          title="下一个匹配"
        >
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <button
        type="button"
        onClick={toggleReplace}
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-sm transition active:scale-[0.94]",
          replaceOpen
            ? "text-amber"
            : "text-muted-foreground hover:text-amber",
        )}
        aria-label="替换"
        aria-pressed={replaceOpen}
        title="替换"
      >
        <ArrowLeftRight className="size-3.5" aria-hidden="true" />
      </button>
      {replaceOpen ? (
        <>
          <span className="mx-1 h-4 w-px shrink-0 bg-white/10" aria-hidden="true" />
          <label className="min-w-[6rem] flex-1">
            <span className="sr-only">替换为</span>
            <input
              value={replacementText}
              onChange={(event) => setReplacementText(event.target.value)}
              className="h-10 w-full bg-transparent px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground"
              placeholder="替换为"
            />
          </label>
          <button
            type="button"
            onClick={replaceCurrentSearchMatch}
            disabled={!canReplace}
            className="inline-flex h-7 shrink-0 items-center justify-center rounded-sm px-2 text-xs font-medium text-muted-foreground transition hover:bg-white/[0.07] hover:text-foreground active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            当前
          </button>
          <button
            type="button"
            onClick={replaceAllSearchMatches}
            disabled={!canReplace}
            className="inline-flex h-7 shrink-0 items-center justify-center rounded-sm bg-cyan/[0.1] px-2 text-xs font-semibold text-cyan transition hover:bg-cyan/[0.16] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            全部
          </button>
        </>
      ) : null}
    </div>
  );
}

function AutoSizeTextarea({
  className,
  value,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & {
  value: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const syncHeight = () => {
      textarea.style.height = "0px";
      textarea.style.height = `${textarea.scrollHeight}px`;
    };

    syncHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(syncHeight);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [value]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      rows={1}
      value={value}
      className={cn("resize-none overflow-hidden", className)}
    />
  );
}

function SubtitleCueCard({
  activeSearchMatchIndex,
  cue,
  innerRef,
  isEditing,
  onTextChange,
  onTranslate,
  onRetryTranslation,
  searchMatchStartIndex,
  searchQuery,
  showTranslationSource,
  translation,
}: {
  activeSearchMatchIndex: number;
  cue: SubtitleCue;
  innerRef?: React.RefObject<HTMLDivElement | null>;
  isEditing: boolean;
  onTextChange: (text: string) => void;
  onTranslate: () => void;
  onRetryTranslation: () => void;
  searchMatchStartIndex: number;
  searchQuery?: string;
  showTranslationSource: boolean;
  translation?: SegmentTranslation;
}) {
  const translatedText = translation?.text?.trim();
  const showTranslatedText = Boolean(translatedText);
  const showSourceText = !showTranslatedText || showTranslationSource;

  return (
    <div ref={innerRef} className="group rounded-md px-2.5 py-2 transition hover:bg-cyan/[0.045]">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="font-mono text-sm font-semibold text-cyan">
          {formatSubtitleRange(cue.startSeconds, cue.endSeconds)}
        </div>
        {!isEditing ? (
          <button
            type="button"
            onClick={onTranslate}
            disabled={translation?.isLoading}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-cyan/[0.1] hover:text-cyan group-hover:opacity-100 focus:opacity-100 active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="翻译该字幕"
            title="翻译该字幕"
          >
            {translation?.isLoading ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Languages className="size-4" aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>
      <div className="whitespace-pre-wrap break-words text-foreground/90">
        {isEditing ? (
          <AutoSizeTextarea
            value={cue.text}
            onChange={(event) => onTextChange(event.target.value)}
            className="min-h-9 w-full rounded-md border border-cyan/20 bg-cyan/[0.035] px-2 py-1.5 text-sm leading-6 text-foreground/90 outline-none transition focus:border-cyan/55 focus:bg-cyan/[0.055] focus:ring-2 focus:ring-cyan/15"
            aria-label={`${formatSubtitleRange(cue.startSeconds, cue.endSeconds)} 字幕`}
          />
        ) : showSourceText ? (
          <TaggedText
            activeSearchMatchIndex={activeSearchMatchIndex}
            searchMatchStartIndex={searchMatchStartIndex}
            searchQuery={searchQuery}
            text={cue.text}
          />
        ) : (
          translatedText
        )}
      </div>
      {!isEditing && showTranslatedText && showTranslationSource ? (
        <div className="mt-1 whitespace-pre-wrap break-words text-foreground/80">{translatedText}</div>
      ) : !isEditing && translation?.isLoading ? (
        <div className="mt-1 text-xs text-muted-foreground">
          <LoadingText>正在翻译</LoadingText>
        </div>
      ) : !isEditing && translation?.error ? (
        <div className="mt-1 flex items-center gap-2 text-xs text-amber">
          <span>{translation.error}</span>
          <NetworkRetryButton
            code={translation.errorCode}
            isRetrying={translation.isLoading}
            onRetry={onRetryTranslation}
          />
        </div>
      ) : null}
    </div>
  );
}

function formatEmotionLabel(emotion: string): string {
  const labels: Record<string, string> = {
    angry: "愤怒",
    disgusted: "厌恶",
    fearful: "恐惧",
    happy: "愉快",
    neutral: "平静",
    sad: "悲伤",
    surprised: "惊讶",
  };
  return labels[emotion] ?? emotion;
}

function formatSegmentEmotion(emotion: string | undefined): string {
  return emotion ? `[情绪:${formatEmotionLabel(emotion)}]` : "";
}

function EmotionBadge({ emotion }: { emotion: string }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-sm bg-amber/[0.08] px-1.5 text-xs font-medium text-amber">
      {formatEmotionLabel(emotion)}
    </span>
  );
}

function TranscriptSegmentCard({
  activeSearchMatchIndex,
  canEditSpeaker,
  isEditing,
  onEditSpeaker,
  onTextChange,
  onTranslate,
  onRetryTranslation,
  segment,
  searchMatchStartIndex,
  searchQuery,
  showSpeakerEmotion,
  speaker,
  showTranslationSource,
  translation,
}: {
  activeSearchMatchIndex: number;
  canEditSpeaker: boolean;
  isEditing: boolean;
  onEditSpeaker: () => void;
  onTextChange: (text: string) => void;
  onTranslate: () => void;
  onRetryTranslation: () => void;
  segment: TranscriptSegment;
  searchMatchStartIndex: number;
  searchQuery?: string;
  showSpeakerEmotion: boolean;
  showTranslationSource: boolean;
  speaker?: SpeakerOption;
  translation?: SegmentTranslation;
}) {
  const [copied, setCopied] = useState(false);
  const speakerAccent = speaker ? speakerAccentClasses(speaker.id) : null;
  const translatedText = translation?.text?.trim();
  const showTranslatedText = Boolean(translatedText);
  const showSourceText = !showTranslatedText || showTranslationSource;
  const shouldHighlightSearch = showSourceText;

  async function copySegment() {
    await navigator.clipboard.writeText(segment.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="group relative rounded-md px-2.5 py-2 transition hover:bg-cyan/[0.045]">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="font-mono text-sm font-semibold text-cyan">
            {formatSegmentTime(segment.startSeconds)}
          </span>
          {speaker ? (
            <span
              className={cn(
                "inline-flex min-w-0 items-center gap-1.5 text-xs font-semibold",
                speakerAccent?.text,
              )}
            >
              <UserRound className={cn("size-3.5 shrink-0", speakerAccent?.icon)} />
              <span className="truncate">{speaker.label}</span>
              {canEditSpeaker ? (
                <button
                  type="button"
                  onClick={onEditSpeaker}
                  className="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm opacity-70 transition hover:bg-white/10 hover:opacity-100 active:scale-[0.94]"
                  aria-label={`编辑${speaker.label}`}
                  title="编辑说话人"
                >
                  <PencilLine className="size-3" aria-hidden="true" />
                </button>
              ) : null}
            </span>
          ) : canEditSpeaker ? (
            <button
              type="button"
              onClick={onEditSpeaker}
              className="inline-flex h-5 items-center gap-1 rounded-sm border border-white/10 px-1.5 text-xs font-medium text-muted-foreground transition hover:border-cyan/30 hover:bg-cyan/[0.06] hover:text-cyan active:scale-[0.98]"
              title="标注说话人"
            >
              <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
              标注说话人
            </button>
          ) : null}
          {showSpeakerEmotion && segment.emotion ? <EmotionBadge emotion={segment.emotion} /> : null}
        </div>
        {!isEditing ? (
          <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              onClick={onTranslate}
              disabled={translation?.isLoading}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-cyan/[0.1] hover:text-cyan active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="翻译该句"
              title="翻译该句"
            >
              {translation?.isLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Languages className="size-4" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={() => void copySegment()}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-amber/[0.12] hover:text-amber active:scale-[0.94]"
              aria-label={copied ? "已复制该时间段" : "复制该时间段"}
              title={copied ? "已复制" : "复制该时间段"}
            >
              {copied ? <Check className="size-4 text-cyan" /> : <Copy className="size-4" />}
            </button>
          </div>
        ) : null}
      </div>
      <div className="whitespace-pre-wrap break-words text-foreground/90">
        {isEditing ? (
          <AutoSizeTextarea
            value={segment.text}
            onChange={(event) => onTextChange(event.target.value)}
            className="min-h-9 w-full rounded-md border border-cyan/20 bg-cyan/[0.035] px-2 py-1.5 text-sm leading-6 text-foreground/90 outline-none transition focus:border-cyan/55 focus:bg-cyan/[0.055] focus:ring-2 focus:ring-cyan/15"
            aria-label={`${formatSegmentTime(segment.startSeconds)} 原文`}
          />
        ) : showSourceText ? (
          <TaggedText
            activeSearchMatchIndex={shouldHighlightSearch ? activeSearchMatchIndex : -1}
            searchMatchStartIndex={shouldHighlightSearch ? searchMatchStartIndex : -1}
            searchQuery={shouldHighlightSearch ? searchQuery : undefined}
            text={segment.text}
          />
        ) : (
          translatedText
        )}
      </div>
      {!isEditing && showTranslatedText && showTranslationSource ? (
        <div className="mt-1 whitespace-pre-wrap break-words text-foreground/80">{translatedText}</div>
      ) : !isEditing && translation?.isLoading ? (
        <div className="mt-1 text-xs text-muted-foreground">
          <LoadingText>正在翻译</LoadingText>
        </div>
      ) : !isEditing && translation?.error ? (
        <div className="mt-1 flex items-center gap-2 text-xs text-amber">
          <span>{translation.error}</span>
          <NetworkRetryButton
            code={translation.errorCode}
            isRetrying={translation.isLoading}
            onRetry={onRetryTranslation}
          />
        </div>
      ) : null}
    </div>
  );
}

function TranslationTargetMenu({
  onTranslate,
  selectedTargetLang,
}: {
  onTranslate: (targetLang: string) => void;
  selectedTargetLang: string;
}) {
  return (
    <div className="mobile-popover w-auto overflow-hidden rounded-md border border-white/12 bg-[#171a27] p-1.5 shadow-2xl shadow-black/40 sm:w-[min(15rem,calc(100vw-2rem))]">
      <div className="content-scroll max-h-[18rem] overflow-auto">
        {TRANSLATION_TARGET_LANG_OPTIONS.map((item) => {
          const selected = selectedTargetLang === item.value;
          return (
            <button
              key={item.value}
              type="button"
              onClick={() => onTranslate(item.value)}
              className={cn(
                "flex h-8 w-full items-center justify-between rounded px-2.5 text-left text-sm font-semibold transition active:scale-[0.99]",
                selected
                  ? "bg-cyan/[0.12] text-cyan"
                  : "text-foreground/90 hover:bg-white/[0.07] hover:text-foreground",
              )}
            >
              <span className="truncate">{item.label}</span>
              {selected ? <Check className="size-3.5 shrink-0" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TranslationSettingsMenu({
  canShowSpeaker,
  canShowSpeakerEmotion,
  config,
  error,
  onClose,
  onConfigChange,
  onSpeakerDisplayChange,
  onSpeakerEmotionDisplayChange,
  onSourceDisplayChange,
  showSpeaker,
  showSpeakerEmotion,
  showSource,
}: {
  canShowSpeaker: boolean;
  canShowSpeakerEmotion: boolean;
  config: TranslationConfig;
  error: string;
  onClose: () => void;
  onConfigChange: Dispatch<SetStateAction<TranslationConfig>>;
  onSpeakerDisplayChange: (checked: boolean) => void;
  onSpeakerEmotionDisplayChange: (checked: boolean) => void;
  onSourceDisplayChange: (checked: boolean) => void;
  showSpeaker: boolean;
  showSpeakerEmotion: boolean;
  showSource: boolean;
}) {
  const hasTranscriptSettings = canShowSpeaker || canShowSpeakerEmotion;

  function updateConfig<K extends keyof TranslationConfig>(key: K, value: TranslationConfig[K]) {
    onConfigChange((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="mobile-popover w-auto rounded-md border border-white/12 bg-[#171a27] p-3 shadow-2xl shadow-black/40 sm:w-[min(22rem,calc(100vw-2rem))]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-foreground">设置</div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground active:scale-[0.94]"
          aria-label="关闭设置"
          title="关闭"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="content-scroll grid max-h-[calc(100dvh_-_6rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] gap-3 overflow-auto pr-1 sm:max-h-[min(32rem,calc(100dvh_-_8rem))]">
        {hasTranscriptSettings ? (
        <details className="group" open>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded text-left text-sm font-semibold text-cyan transition hover:text-foreground">
            <span>转录</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="mt-3 grid gap-2 pl-2">
            {canShowSpeaker ? (
              <CopyOptionSwitch checked={showSpeaker} label="是否显示说话人" onChange={onSpeakerDisplayChange} />
            ) : null}
            {canShowSpeakerEmotion ? (
              <CopyOptionSwitch checked={showSpeakerEmotion} label="是否显示说话人情绪" onChange={onSpeakerEmotionDisplayChange} />
            ) : null}
          </div>
        </details>
        ) : null}
        <details className="group" open>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded text-left text-sm font-semibold text-cyan transition hover:text-foreground">
            <span>翻译</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="mt-3 grid gap-2 pl-2">
            <CopyOptionSwitch checked={showSource} label="显示翻译原文" onChange={onSourceDisplayChange} />
            <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">
              <SettingLabel help={TRANSLATION_SETTING_HELP.domains} label="领域提示" />
              <textarea
                value={config.domains}
                onChange={(event) => updateConfig("domains", event.target.value)}
                rows={2}
                placeholder="English only. Example: Translate into concise IT documentation style."
                className="max-h-24 min-h-14 resize-y rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-xs leading-5 text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-cyan/55 focus:ring-2 focus:ring-cyan/15"
              />
            </label>
            <TranslationPairTextarea
              help={TRANSLATION_SETTING_HELP.terms}
              label="术语表"
              placeholder={"EchoLens => EchoLens\nASR => automatic speech recognition"}
              value={config.termsText}
              onChange={(value) => updateConfig("termsText", value)}
            />
            <TranslationPairTextarea
              help={TRANSLATION_SETTING_HELP.tm}
              label="翻译记忆"
              placeholder={"Click download => 点击下载\nProcessing failed => 处理失败"}
              value={config.tmText}
              onChange={(value) => updateConfig("tmText", value)}
            />
          </div>
        </details>
        {error ? <div className="text-xs font-medium text-amber">{error}</div> : null}
      </div>
    </div>
  );
}

function TranslationPairTextarea({
  help,
  label,
  onChange,
  placeholder,
  value,
}: {
  help: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">
      <SettingLabel help={help} label={label} />
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={2}
        placeholder={placeholder}
        className="max-h-28 min-h-14 resize-y rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-xs leading-5 text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-cyan/55 focus:ring-2 focus:ring-cyan/15"
      />
    </label>
  );
}

function SettingLabel({ help, label }: { help: string; label: string }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex w-fit items-center gap-1">
      <span>{label}</span>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
        className="inline-flex size-3.5 items-center justify-center rounded-full text-muted-foreground transition hover:bg-cyan/[0.1] hover:text-cyan active:scale-[0.94]"
        aria-label={`${label}说明`}
        aria-expanded={open}
        title={`${label}说明`}
      >
        <Info className="size-3" aria-hidden="true" />
      </button>
      {open ? (
        <span className="absolute left-0 top-5 z-40 w-[min(17rem,calc(100vw-3rem))] rounded-md border border-white/12 bg-[#0f1420] p-2 text-left text-[11px] font-medium leading-5 text-muted-foreground shadow-xl shadow-black/35">
          {help}
        </span>
      ) : null}
    </span>
  );
}

function SummaryPromptMenu({
  builtInPrompts,
  customPrompts,
  deletingCustomPromptId,
  error,
  focusedCustomPromptId,
  onDeleteCustomPrompt,
  onCustomPrompt,
  onEditCustomPrompt,
  onSelect,
}: {
  builtInPrompts: SummaryPrompt[];
  customPrompts: CustomSummaryPrompt[];
  deletingCustomPromptId?: string | null;
  error?: string;
  focusedCustomPromptId?: string | null;
  onDeleteCustomPrompt: (prompt: CustomSummaryPrompt) => void;
  onCustomPrompt: () => void;
  onEditCustomPrompt: (prompt: CustomSummaryPrompt) => void;
  onSelect: (prompt: SummaryPrompt) => void;
}) {
  const [builtInOpen, setBuiltInOpen] = useState(true);
  const [customOpen, setCustomOpen] = useState(true);
  const focusedCustomPromptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!focusedCustomPromptId || !customOpen) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      focusedCustomPromptRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [customOpen, customPrompts, focusedCustomPromptId]);

  return (
    <div className="mobile-popover w-auto overflow-hidden rounded-md border border-white/12 bg-[#171a27] shadow-2xl shadow-black/40 sm:w-[min(20rem,calc(100vw-2rem))]">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
        <div className="text-sm font-semibold text-foreground">提示词库</div>
        <button
          type="button"
          onClick={onCustomPrompt}
          className="inline-flex h-8 items-center justify-center gap-1 rounded-md px-2 text-xs font-semibold text-cyan transition hover:bg-cyan/[0.1] active:scale-[0.98]"
          aria-label="新建自定义提示词"
          title="新建自定义提示词"
        >
          <span>自定义提示词</span>
          <Plus className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="content-scroll max-h-[min(30rem,calc(100dvh-9rem))] overflow-auto py-1">
        <PromptMenuSectionHeader
          count={builtInPrompts.length}
          open={builtInOpen}
          title="内置提示词"
          onToggle={() => setBuiltInOpen((value) => !value)}
        />
        {builtInOpen ? builtInPrompts.map((prompt) => (
          <PromptMenuItem
            key={prompt.id}
            prompt={prompt}
            onSelect={onSelect}
          />
        )) : null}

        <PromptMenuSectionHeader
          count={customPrompts.length}
          open={customOpen}
          title="自定义提示词"
          onToggle={() => setCustomOpen((value) => !value)}
        />
        {customOpen ? (
          customPrompts.length ? customPrompts.map((prompt) => {
            const focused = focusedCustomPromptId === prompt.id;
            return (
              <CustomPromptMenuItem
                deleting={deletingCustomPromptId === prompt.id}
                itemRef={focused ? (node) => {
                  focusedCustomPromptRef.current = node;
                } : undefined}
                key={prompt.id}
                prompt={prompt}
                onDelete={onDeleteCustomPrompt}
                onEdit={onEditCustomPrompt}
                onSelect={onSelect}
              />
            );
          }) : (
            <div className="px-3 py-3 text-xs leading-5 text-muted-foreground">暂无自定义提示词</div>
          )
        ) : null}
        {error ? (
          <div className="px-3 py-2 text-xs font-medium leading-5 text-amber">{error}</div>
        ) : null}
      </div>
    </div>
  );
}

function PromptMenuSectionHeader({
  count,
  onToggle,
  open,
  title,
}: {
  count: number;
  onToggle: () => void;
  open: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-9 w-full items-center justify-between gap-3 border-t border-white/10 px-3 text-left text-xs font-semibold text-cyan transition first:border-t-0 hover:bg-cyan/[0.06] hover:text-cyan"
      aria-expanded={open}
    >
      <span>{title}</span>
      <span className="inline-flex items-center gap-1.5">
        <span className="text-xs tabular-nums text-cyan/80">{count}</span>
        <ChevronDown className={cn("size-3.5 transition", open ? "rotate-180" : "")} aria-hidden="true" />
      </span>
    </button>
  );
}

function PromptMenuItem({
  onSelect,
  prompt,
}: {
  onSelect: (prompt: SummaryPrompt) => void;
  prompt: SummaryPrompt;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(prompt)}
      className="block w-full px-3 py-2.5 text-left transition hover:bg-cyan/[0.07] active:bg-cyan/[0.1]"
    >
      <div className="text-xs font-semibold leading-5 text-foreground">{prompt.title}</div>
      <div className="mt-0.5 line-clamp-2 text-[11px] leading-5 text-muted-foreground">
        {prompt.description}
      </div>
    </button>
  );
}

function CustomPromptMenuItem({
  deleting,
  itemRef,
  onDelete,
  onEdit,
  onSelect,
  prompt,
}: {
  deleting: boolean;
  itemRef?: (node: HTMLDivElement | null) => void;
  onDelete: (prompt: CustomSummaryPrompt) => void;
  onEdit: (prompt: CustomSummaryPrompt) => void;
  onSelect: (prompt: SummaryPrompt) => void;
  prompt: CustomSummaryPrompt;
}) {
  return (
    <div
      ref={itemRef}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 px-1.5 transition hover:bg-cyan/[0.07]"
    >
      <button
        type="button"
        onClick={() => onSelect(prompt)}
        className="min-w-0 px-1.5 py-2.5 text-left active:bg-cyan/[0.1]"
      >
        <div className="text-xs font-semibold leading-5 text-foreground">{prompt.title}</div>
        <div className="mt-0.5 line-clamp-2 text-[11px] leading-5 text-muted-foreground">
          {prompt.description}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => onEdit(prompt)}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-cyan active:scale-[0.94]"
          aria-label={`编辑${prompt.title}`}
          title="编辑"
        >
          <PencilLine className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(prompt)}
          disabled={deleting}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`删除${prompt.title}`}
          title="删除"
        >
          {deleting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Trash2 className="size-4" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

function SummaryHistoryMenu({
  deletingSummaryId,
  onDelete,
  onSelect,
  summaries,
}: {
  deletingSummaryId: string | null;
  onDelete: (summary: TranscriptHistorySummary) => void;
  onSelect: (summary: TranscriptHistorySummary) => void;
  summaries: TranscriptHistorySummary[];
}) {
  return (
    <div className="mobile-popover w-64 overflow-hidden rounded-md border border-white/12 bg-[#171a27] shadow-2xl shadow-black/40">
      <div className="content-scroll max-h-72 overflow-auto py-1">
        {summaries.map((summary) => (
          <div
            key={summary.id}
            className="group flex min-w-0 items-center gap-1 px-2 py-1 transition hover:bg-cyan/[0.07]"
          >
            <button
              type="button"
              onClick={() => onSelect(summary)}
              className="min-w-0 flex-1 rounded px-1 py-1 text-left"
            >
              <div className="truncate text-xs font-semibold text-foreground">{summary.promptTitle}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {formatFriendlyDateTime(summary.createdAt)}
              </div>
            </button>
            <button
              type="button"
              onClick={() => onDelete(summary)}
              disabled={deletingSummaryId === summary.id}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 transition hover:bg-rose-400/[0.12] hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40 group-hover:opacity-100"
              aria-label="删除AI总结"
              title="删除"
            >
              {deletingSummaryId === summary.id
                ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                : <Trash2 className="size-3.5" aria-hidden="true" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

async function downloadCachedAsset(
  sourceUrl: string,
  filename: string,
  work: ResolvedDouyinWork,
): Promise<void> {
  const saved = await saveToDownloadDirectory(sourceUrl, filename, {
    authorName: work.authorName,
    caption: work.caption,
    workId: work.id,
  });
  if (saved) {
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = sourceUrl;
  anchor.download = filename;
  anchor.click();
}

function CopyTranscriptMenu({
  canIncludeSpeaker,
  canIncludeSpeakerEmotion,
  copied,
  includeEmotion,
  includeSpeaker,
  includeTimestamp,
  onCopy,
  onEmotionChange,
  onSpeakerChange,
  onTimestampChange,
}: {
  canIncludeSpeaker: boolean;
  canIncludeSpeakerEmotion: boolean;
  copied: boolean;
  includeEmotion: boolean;
  includeSpeaker: boolean;
  includeTimestamp: boolean;
  onCopy: () => void;
  onEmotionChange: (checked: boolean) => void;
  onSpeakerChange: (checked: boolean) => void;
  onTimestampChange: (checked: boolean) => void;
}) {
  return (
    <div className="mobile-popover w-auto rounded-md border border-white/12 bg-[#171a27] p-2 shadow-2xl shadow-black/40 sm:w-56">
      <CopyOptionSwitch checked={includeTimestamp} label="时间戳" onChange={onTimestampChange} />
      {canIncludeSpeaker ? (
        <CopyOptionSwitch checked={includeSpeaker} label="说话人" onChange={onSpeakerChange} />
      ) : null}
      {canIncludeSpeakerEmotion ? (
        <CopyOptionSwitch checked={includeEmotion} label="说话人情绪" onChange={onEmotionChange} />
      ) : null}
      <button
        type="button"
        onClick={onCopy}
        className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-cyan text-sm font-semibold text-black transition hover:brightness-110 active:scale-[0.99]"
      >
        {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

function DownloadTranscriptMenu({
  canIncludeSpeaker,
  canIncludeSpeakerEmotion,
  format,
  includeEmotion,
  includeSpeaker,
  includeTimestamp,
  onDownload,
  onEmotionChange,
  onFormatChange,
  onSpeakerChange,
  onTimestampChange,
}: {
  canIncludeSpeaker: boolean;
  canIncludeSpeakerEmotion: boolean;
  format: TranscriptDownloadFormat;
  includeEmotion: boolean;
  includeSpeaker: boolean;
  includeTimestamp: boolean;
  onDownload: () => void;
  onEmotionChange: (checked: boolean) => void;
  onFormatChange: (format: TranscriptDownloadFormat) => void;
  onSpeakerChange: (checked: boolean) => void;
  onTimestampChange: (checked: boolean) => void;
}) {
  const formats: { label: string; value: TranscriptDownloadFormat }[] = [
    { label: "TXT", value: "txt" },
    { label: "MD", value: "md" },
    { label: "JSON", value: "json" },
    { label: "SRT", value: "srt" },
    { label: "VTT", value: "vtt" },
  ];
  return (
    <div className="mobile-popover w-auto rounded-md border border-white/12 bg-[#171a27] p-2 shadow-2xl shadow-black/40 sm:w-56">
      <CopyOptionSwitch checked={includeTimestamp} label="时间戳" onChange={onTimestampChange} />
      {canIncludeSpeaker ? (
        <CopyOptionSwitch checked={includeSpeaker} label="说话人" onChange={onSpeakerChange} />
      ) : null}
      {canIncludeSpeakerEmotion ? (
        <CopyOptionSwitch checked={includeEmotion} label="说话人情绪" onChange={onEmotionChange} />
      ) : null}
      <div className="mt-2 grid grid-cols-5 gap-1 rounded-md bg-black/20 p-1">
        {formats.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => onFormatChange(item.value)}
            className={cn(
              "h-7 rounded-sm text-xs font-semibold transition active:scale-[0.98]",
              format === item.value
                ? "bg-cyan text-black"
                : "text-muted-foreground hover:bg-white/10 hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onDownload}
        className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-cyan text-sm font-semibold text-black transition hover:brightness-110 active:scale-[0.99]"
      >
        <Download className="size-4" aria-hidden="true" />
        下载
      </button>
    </div>
  );
}

function CopyOptionSwitch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex h-8 items-center justify-between gap-3 text-xs font-semibold text-foreground/85">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
        aria-label={label}
      />
      <span
        aria-hidden="true"
        className={cn(
          "relative h-4 w-8 shrink-0 rounded-full transition peer-focus-visible:ring-2 peer-focus-visible:ring-cyan/30",
          checked ? "bg-cyan/75" : "bg-[#344158]",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 size-3 rounded-full transition",
            checked ? "translate-x-4 bg-black/80" : "translate-x-0 bg-[#1d2738]",
          )}
        />
      </span>
    </label>
  );
}

function SpeakerEditorDialog({
  customSpeakerIds,
  onAddSpeaker,
  onAssignSpeaker,
  onClose,
  onDeleteSpeaker,
  onRenameSpeaker,
  selectedSpeakerId,
  speakers,
}: {
  customSpeakerIds: string[];
  onAddSpeaker: (label: string) => void;
  onAssignSpeaker: (speakerId: string | undefined) => void;
  onClose: () => void;
  onDeleteSpeaker: (speakerId: string) => void;
  onRenameSpeaker: (speakerId: string, label: string) => void;
  selectedSpeakerId?: string;
  speakers: SpeakerOption[];
}) {
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);
  const [isAddingSpeaker, setIsAddingSpeaker] = useState(false);
  const [speakerDraft, setSpeakerDraft] = useState("");
  const [newSpeakerName, setNewSpeakerName] = useState("");

  function startEditingSpeaker(speaker: SpeakerOption) {
    setEditingSpeakerId(speaker.id);
    setSpeakerDraft(speaker.label);
  }

  function saveSpeakerName() {
    if (!editingSpeakerId || !speakerDraft.trim()) {
      return;
    }
    onRenameSpeaker(editingSpeakerId, speakerDraft);
    setEditingSpeakerId(null);
    setSpeakerDraft("");
  }

  function addSpeaker() {
    if (!newSpeakerName.trim()) {
      return;
    }
    onAddSpeaker(newSpeakerName.trim());
    setNewSpeakerName("");
    setIsAddingSpeaker(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-sm sm:items-center sm:px-4 sm:py-6">
      <div className="max-h-[calc(100dvh_-_1.5rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] w-full max-w-md overflow-hidden rounded-lg border border-white/20 bg-background shadow-2xl shadow-black/40 sm:max-h-[calc(100dvh_-_3rem)]">
        <div className="flex h-14 items-center justify-between gap-3 border-b border-white/10 px-4">
          <h4 className="text-sm font-semibold text-foreground">编辑说话人</h4>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
            aria-label="关闭"
            title="关闭"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="max-h-[min(26rem,calc(100dvh_-_9rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom)))] overflow-auto p-3">
          <div className="grid gap-1">
            {speakers.map((speaker) => {
              const isSelected = speaker.id === selectedSpeakerId;
              const isEditing = speaker.id === editingSpeakerId;
              const canDelete = customSpeakerIds.includes(speaker.id);
              const accent = speakerAccentClasses(speaker.id);

              return (
                <div
                  key={speaker.id}
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-md px-3 transition",
                    isSelected ? "bg-cyan/[0.08]" : "hover:bg-white/[0.05]",
                    isEditing ? "h-12" : "h-11",
                  )}
                >
                  {isEditing ? (
                    <>
                      <input
                        value={speakerDraft}
                        onChange={(event) => setSpeakerDraft(event.target.value)}
                        className="h-9 min-w-0 flex-1 rounded-md border border-cyan/50 bg-black/20 px-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-cyan/20"
                        placeholder="说话人名称"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={saveSpeakerName}
                        disabled={!speakerDraft.trim()}
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label="保存说话人名称"
                        title="保存"
                      >
                        <Check className="size-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingSpeakerId(null)}
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
                        aria-label="取消编辑说话人名称"
                        title="取消"
                      >
                        <X className="size-4" aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onAssignSpeaker(speaker.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <UserRound className={cn("size-4 shrink-0", accent.icon)} aria-hidden="true" />
                        <span className={cn("truncate text-sm font-semibold", accent.text)}>{speaker.label}</span>
                      </button>
                      {isSelected ? <Check className="size-4 shrink-0 text-cyan" aria-hidden="true" /> : null}
                      <button
                        type="button"
                        onClick={() => startEditingSpeaker(speaker)}
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-cyan active:scale-[0.94]"
                        aria-label={`编辑${speaker.label}`}
                        title="编辑名称"
                      >
                        <PencilLine className="size-4" aria-hidden="true" />
                      </button>
                      {canDelete ? (
                        <button
                          type="button"
                          onClick={() => onDeleteSpeaker(speaker.id)}
                          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive active:scale-[0.94]"
                          aria-label={`删除${speaker.label}`}
                          title="删除说话人"
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-3 border-t border-white/10 pt-3">
            {isAddingSpeaker ? (
              <div className="flex items-center gap-2">
                <input
                  value={newSpeakerName}
                  onChange={(event) => setNewSpeakerName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      addSpeaker();
                    }
                  }}
                  className="h-10 min-w-0 flex-1 rounded-md border border-white/15 bg-black/20 px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-cyan focus:ring-2 focus:ring-cyan/20"
                  placeholder="添加新说话人名称"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={addSpeaker}
                  disabled={!newSpeakerName.trim()}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.08] disabled:cursor-not-allowed disabled:text-muted-foreground"
                  aria-label="保存新说话人"
                  title="保存"
                >
                  <Check className="size-5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsAddingSpeaker(false);
                    setNewSpeakerName("");
                  }}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
                  aria-label="取消添加说话人"
                  title="取消"
                >
                  <X className="size-5" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsAddingSpeaker(true)}
                className="inline-flex h-10 items-center gap-2 rounded-md px-2 text-sm font-medium text-muted-foreground transition hover:bg-cyan/[0.06] hover:text-cyan active:scale-[0.98]"
              >
                <Plus className="size-5" aria-hidden="true" />
                添加新说话人
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomPromptDialog({
  error,
  initialPrompt = "",
  initialTitle = "",
  isSaving,
  mode,
  onClose,
  onSave,
}: {
  error?: string;
  initialPrompt?: string;
  initialTitle?: string;
  isSaving: boolean;
  mode: "create" | "edit";
  onClose: () => void;
  onSave: (title: string, prompt: string) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [prompt, setPrompt] = useState(initialPrompt);
  const titleInputId = useId();
  const promptInputId = useId();
  const canSave = title.trim().length > 0 && prompt.trim().length > 0;
  const actionText = mode === "edit" ? "更新" : "保存";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-sm sm:items-center sm:px-4 sm:py-6">
      <div className="max-h-[calc(100dvh_-_1.5rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] w-full max-w-lg overflow-auto rounded-lg border border-white/20 bg-background p-3 shadow-2xl shadow-black/40 sm:max-h-[calc(100dvh_-_3rem)]">
        <div className="mb-2 flex items-center justify-between gap-3">
          <label htmlFor={titleInputId} className="text-sm font-semibold text-foreground">提示词名称</label>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
            aria-label="关闭"
            title="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
        <input
          id={titleInputId}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="h-9 w-full rounded-md border border-white/15 bg-black/20 px-3 text-sm outline-none transition placeholder:text-xs placeholder:text-muted-foreground focus:border-cyan focus:ring-2 focus:ring-cyan/20"
          placeholder="例如：投研纪要摘要"
        />
        <label htmlFor={promptInputId} className="mt-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-foreground">提示词内容</span>
          <textarea
            id={promptInputId}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            className="h-32 w-full resize-none rounded-md border border-white/15 bg-black/20 p-3 text-sm leading-6 outline-none transition placeholder:text-xs placeholder:text-muted-foreground focus:border-cyan focus:ring-2 focus:ring-cyan/20"
            placeholder="描述 AI 应如何总结当前转录内容，包括关注重点、输出结构和语气要求。"
          />
        </label>
        {error ? (
          <div className="mt-3 text-xs font-medium leading-5 text-amber">{error}</div>
        ) : null}
        <div className="mt-3 grid gap-2.5 sm:flex sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="inline-flex h-10 items-center justify-center rounded-md border border-white/15 px-4 text-sm font-semibold text-foreground transition hover:bg-white/10 active:scale-[0.98] sm:h-9"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(title.trim(), prompt.trim())}
            disabled={!canSave || isSaving}
            className="inline-flex h-10 items-center justify-center rounded-md bg-cyan px-4 text-sm font-semibold text-black transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground sm:h-9"
          >
            {isSaving ? `${actionText}中` : actionText}
          </button>
        </div>
      </div>
    </div>
  );
}

function readDisplayTranscriptSegments(
  content: string,
  segments: TranscriptSegment[] | undefined,
): TranscriptSegment[] {
  const usableSegments = segments?.filter((segment) => segment.text.trim());
  if (usableSegments?.length) {
    return usableSegments;
  }

  const text = content.trim();
  return text ? [{ endSeconds: 0, startSeconds: 0, text }] : [];
}

function buildTranscriptCopyText(
  segments: TranscriptSegment[],
  options: {
    includeEmotion: boolean;
    includeSpeaker: boolean;
    includeTimestamp: boolean;
    resolveSpeaker: (segment: TranscriptSegment, index: number) => string;
  },
): string {
  return segments
    .map((segment, index) => {
      const prefix = [
        options.includeTimestamp ? formatSegmentTime(segment.startSeconds) : "",
        options.includeSpeaker ? options.resolveSpeaker(segment, index) : "",
        options.includeEmotion ? formatSegmentEmotion(segment.emotion) : "",
      ].filter(Boolean);
      return `${prefix.length ? `${prefix.join(" ")} ` : ""}${segment.text}`;
    })
    .join("\n");
}

function buildTranscriptDownloadContent(
  segments: TranscriptSegment[],
  options: {
    format: TextTranscriptDownloadFormat;
    includeEmotion: boolean;
    includeSpeaker: boolean;
    includeTimestamp: boolean;
    resolveSpeaker: (segment: TranscriptSegment, index: number) => string;
  },
): { content: string; extension: string; mimeType: string } {
  if (options.format === "json") {
    const entries = segments.map((segment, index) => ({
      ...(options.includeTimestamp
        ? {
            end: formatSegmentTime(segment.endSeconds),
            endSeconds: segment.endSeconds,
            start: formatSegmentTime(segment.startSeconds),
            startSeconds: segment.startSeconds,
          }
        : {}),
      ...(options.includeSpeaker ? { speaker: options.resolveSpeaker(segment, index) } : {}),
      ...(options.includeEmotion && segment.emotion ? { emotion: formatEmotionLabel(segment.emotion) } : {}),
      text: segment.text,
    }));

    return {
      content: JSON.stringify({ segments: entries }, null, 2),
      extension: "json",
      mimeType: "application/json;charset=utf-8",
    };
  }

  if (options.format === "md") {
    return {
      content: segments
        .map((segment, index) => {
          const prefix = [
            options.includeTimestamp ? `\`${formatSegmentTime(segment.startSeconds)}\`` : "",
            options.includeSpeaker ? `**${options.resolveSpeaker(segment, index)}**` : "",
            options.includeEmotion ? `_${formatSegmentEmotion(segment.emotion)}_` : "",
          ].filter(Boolean);
          return `${prefix.length ? `${prefix.join(" ")} ` : ""}${segment.text}`;
        })
        .join("\n\n"),
      extension: "md",
      mimeType: "text/markdown;charset=utf-8",
    };
  }

  return {
    content: buildTranscriptCopyText(segments, options),
    extension: "txt",
    mimeType: "text/plain;charset=utf-8",
  };
}

function buildSubtitleDownloadContent(
  cues: SubtitleCue[],
  format: Extract<TranscriptDownloadFormat, "srt" | "vtt">,
  options: { includeEmotion: boolean; includeTimestamp: boolean },
): { content: string; extension: string; mimeType: string } {
  return {
    content: buildSubtitleFileContent(cues, format, options),
    extension: format,
    mimeType: format === "vtt" ? "text/vtt;charset=utf-8" : "application/x-subrip;charset=utf-8",
  };
}

function buildSubtitleFileContent(
  cues: SubtitleCue[],
  format: "srt" | "vtt",
  options: { includeEmotion: boolean; includeTimestamp: boolean },
): string {
  if (!options.includeTimestamp) {
    return `${cues.map((cue) => formatSubtitleCueText(cue, options)).join("\n\n")}\n`;
  }

  const body = cues
    .map((cue, index) => {
      const timing = `${formatSubtitleTimestamp(cue.startSeconds, format)} --> ${formatSubtitleTimestamp(cue.endSeconds, format)}`;
      return format === "srt"
        ? `${index + 1}\n${timing}\n${formatSubtitleCueText(cue, options)}`
        : `${timing}\n${formatSubtitleCueText(cue, options)}`;
    })
    .join("\n\n");

  return format === "vtt" ? `WEBVTT\n\n${body}\n` : `${body}\n`;
}

function formatSubtitleCueText(cue: SubtitleCue, options: { includeEmotion: boolean }): string {
  const emotion = options.includeEmotion ? formatSegmentEmotion(cue.emotion) : "";
  return emotion ? `${emotion} ${cue.text}` : cue.text;
}

function buildSubtitleCues(segments: TranscriptSegment[]): SubtitleCue[] {
  const cues = segments.flatMap((segment) => splitSegmentIntoSubtitleCues(segment));
  return cues.reduce<SubtitleCue[]>((normalized, cue) => {
    const previous = normalized.at(-1);
    const startSeconds = previous ? Math.max(cue.startSeconds, previous.endSeconds + 0.02) : cue.startSeconds;
    const endSeconds = Math.max(cue.endSeconds, startSeconds + 0.6);
    normalized.push({ ...cue, startSeconds, endSeconds });
    return normalized;
  }, []);
}

function splitSegmentIntoSubtitleCues(segment: TranscriptSegment): SubtitleCue[] {
  const text = normalizeSubtitleText(segment.text);
  if (!text) {
    return [];
  }

  const parts = splitSubtitleText(text);
  if (parts.length <= 1) {
    return [{
      endSeconds: Math.max(segment.endSeconds, segment.startSeconds + 0.8),
      emotion: segment.emotion,
      startSeconds: Math.max(segment.startSeconds, 0),
      text: formatSubtitleLines(text),
    }];
  }

  const duration = Math.max(segment.endSeconds - segment.startSeconds, parts.length * 0.75);
  const weights = parts.map((part) => Math.max(part.replace(/\s/gu, "").length, 1));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cursor = Math.max(segment.startSeconds, 0);

  return parts.map((part, index) => {
    const remaining = parts.length - index;
    const isLast = index === parts.length - 1;
    const rawDuration = isLast
      ? Math.max(segment.endSeconds - cursor, 0.75)
      : duration * (weights[index] / totalWeight);
    const cueDuration = Math.max(rawDuration, 0.75);
    const endSeconds = isLast
      ? Math.max(segment.endSeconds, cursor + cueDuration)
      : Math.min(segment.endSeconds - (remaining - 1) * 0.75, cursor + cueDuration);
    const cue = {
      startSeconds: cursor,
      endSeconds: Math.max(endSeconds, cursor + 0.75),
      emotion: segment.emotion,
      text: formatSubtitleLines(part),
    };
    cursor = cue.endSeconds;
    return cue;
  });
}

function normalizeSubtitleText(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.!?;:，。！？；：])/gu, "$1")
    .replace(/([（([{])\s+/gu, "$1")
    .replace(/\s+([）)\]}])/gu, "$1")
    .trim();
}

function splitSubtitleText(text: string): string[] {
  const sentences = text
    .split(/(?<=[。！？!?；;])\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks = (sentences.length ? sentences : [text]).flatMap((sentence) =>
    splitSubtitleSentence(sentence, SUBTITLE_MAX_CHARS_PER_CUE),
  );
  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}

function splitSubtitleSentence(sentence: string, maxLength: number): string[] {
  if (subtitleTextLength(sentence) <= maxLength) {
    return [sentence];
  }

  const parts: string[] = [];
  let remaining = sentence.trim();
  while (subtitleTextLength(remaining) > maxLength) {
    const splitIndex = findSubtitleSplitIndex(remaining, maxLength);
    parts.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining) {
    parts.push(remaining);
  }
  return parts;
}

function findSubtitleSplitIndex(text: string, maxLength: number): number {
  const hardLimit = Math.min(text.length, maxLength);
  const window = text.slice(0, hardLimit + 1);
  const punctuationIndex = Math.max(
    window.lastIndexOf(","),
    window.lastIndexOf("，"),
    window.lastIndexOf(":"),
    window.lastIndexOf("："),
  );
  if (punctuationIndex >= Math.floor(maxLength * 0.45)) {
    return punctuationIndex + 1;
  }

  const spaceIndex = window.lastIndexOf(" ");
  if (spaceIndex >= Math.floor(maxLength * 0.45)) {
    return spaceIndex + 1;
  }

  return hardLimit;
}

function formatSubtitleLines(text: string): string {
  const cleanText = normalizeSubtitleText(text);
  if (subtitleTextLength(cleanText) <= SUBTITLE_MAX_LINE_LENGTH) {
    return cleanText;
  }

  const splitIndex = findSubtitleSplitIndex(cleanText, Math.ceil(cleanText.length / 2));
  const first = cleanText.slice(0, splitIndex).trim();
  const second = cleanText.slice(splitIndex).trim();
  return second ? `${first}\n${second}` : first;
}

function subtitleTextLength(text: string): number {
  return Array.from(text).length;
}

function formatSubtitleRange(startSeconds: number, endSeconds: number): string {
  return `${formatSegmentTime(startSeconds)} - ${formatSegmentTime(endSeconds)}`;
}

function formatSubtitleTimestamp(seconds: number, format: "srt" | "vtt"): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  const delimiter = format === "srt" ? "," : ".";
  return [
    hours.toString().padStart(2, "0"),
    minutes.toString().padStart(2, "0"),
    wholeSeconds.toString().padStart(2, "0"),
  ].join(":") + `${delimiter}${milliseconds.toString().padStart(3, "0")}`;
}

function downloadTextFile(content: string, fileName: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function countSearchMatches(text: string, query: string): number {
  if (!query) {
    return 0;
  }

  const source = text.toLocaleLowerCase();
  const target = query.toLocaleLowerCase();
  let count = 0;
  let index = source.indexOf(target);

  while (index !== -1) {
    count += 1;
    index = source.indexOf(target, index + target.length);
  }

  return count;
}

function replaceSearchMatch(
  text: string,
  query: string,
  replacement: string,
  matchIndex: number,
): string {
  if (!query || matchIndex < 0) {
    return text;
  }

  const source = text.toLocaleLowerCase();
  const target = query.toLocaleLowerCase();
  let index = source.indexOf(target);
  let currentMatchIndex = 0;
  while (index !== -1 && currentMatchIndex < matchIndex) {
    index = source.indexOf(target, index + target.length);
    currentMatchIndex += 1;
  }

  return index === -1
    ? text
    : `${text.slice(0, index)}${replacement}${text.slice(index + query.length)}`;
}

function replaceAllSearchMatchesInText(
  text: string,
  query: string,
  replacement: string,
): string {
  if (!query) {
    return text;
  }

  const source = text.toLocaleLowerCase();
  const target = query.toLocaleLowerCase();
  const parts: string[] = [];
  let cursor = 0;
  let index = source.indexOf(target);
  while (index !== -1) {
    parts.push(text.slice(cursor, index), replacement);
    cursor = index + query.length;
    index = source.indexOf(target, cursor);
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

type SearchMatchRange = {
  count: number;
  startIndex: number;
};

function buildSearchMatchRanges(
  segments: TranscriptSegment[],
  query: string,
): SearchMatchRange[] {
  let nextStartIndex = 0;

  return segments.map((segment) => {
    const count = countSearchMatches(segment.text, query);
    const range = {
      count,
      startIndex: count > 0 ? nextStartIndex : -1,
    };
    nextStartIndex += count;
    return range;
  });
}

function findSearchMatchSegmentIndex(
  ranges: SearchMatchRange[],
  activeMatchIndex: number,
): number {
  return ranges.findIndex((range) =>
    range.startIndex >= 0 &&
    activeMatchIndex >= range.startIndex &&
    activeMatchIndex < range.startIndex + range.count,
  );
}

function scrollSearchMatchIntoContainer(
  container: HTMLDivElement | null,
  matchElement: HTMLDivElement | null,
): void {
  if (!container || !matchElement) {
    return;
  }

  if (container.scrollHeight <= container.clientHeight + 1) {
    matchElement.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    return;
  }

  const padding = 40;
  const containerRect = container.getBoundingClientRect();
  const matchRect = matchElement.getBoundingClientRect();
  const matchTop = container.scrollTop + (matchRect.top - containerRect.top);
  const matchBottom = matchTop + matchRect.height;
  const visibleTop = container.scrollTop + padding;
  const visibleBottom = container.scrollTop + container.clientHeight - padding;

  if (matchTop >= visibleTop && matchBottom <= visibleBottom) {
    return;
  }

  const centeredTop = matchTop - (container.clientHeight / 2) + (matchRect.height / 2);
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTo({
    top: Math.max(0, Math.min(centeredTop, maxScrollTop)),
    behavior: "auto",
  });
}

function formatSegmentTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function buildTranscriptSegmentKey(segment: TranscriptSegment, index: number): string {
  return buildTimedTextKey(segment, index);
}

function buildTimedTextKey(item: Pick<TranscriptSegment, "endSeconds" | "startSeconds">, index: number): string {
  return `${index}:${item.startSeconds}:${item.endSeconds}`;
}

function getTranscriptSpeakerIds(segments: TranscriptSegment[]): string[] {
  return [...new Set(segments.map((segment) => segment.speakerId).filter((id): id is string => Boolean(id)))].sort(
    compareSpeakerIds,
  );
}

function buildSpeakerOptions(
  defaultSpeakerIds: string[],
  customSpeakerIds: string[],
  segmentSpeakerOverrides: Record<string, string | undefined>,
  speakerNames: Record<string, string>,
): SpeakerOption[] {
  const speakerIds = new Set<string>([...defaultSpeakerIds, ...customSpeakerIds]);
  for (const speakerId of Object.values(segmentSpeakerOverrides)) {
    if (speakerId) {
      speakerIds.add(speakerId);
    }
  }

  return [...speakerIds].sort(compareSpeakerIds).map((speakerId) => ({
    id: speakerId,
    label: speakerNames[speakerId]?.trim() || `说话人${speakerId}`,
  }));
}

function getSpeakerOption(speakers: SpeakerOption[], speakerId: string): SpeakerOption {
  return speakers.find((speaker) => speaker.id === speakerId) ?? {
    id: speakerId,
    label: `说话人${speakerId}`,
  };
}

function nextSpeakerId(speakerIds: string[]): string {
  const used = new Set(speakerIds);
  let next = 1;
  while (used.has(String(next))) {
    next += 1;
  }
  return String(next);
}

function compareSpeakerIds(first: string, second: string): number {
  const firstNumber = Number(first);
  const secondNumber = Number(second);
  if (Number.isInteger(firstNumber) && Number.isInteger(secondNumber)) {
    return firstNumber - secondNumber;
  }

  return first.localeCompare(second, "zh-Hans-CN", { numeric: true });
}

function speakerAccentClasses(speakerId: string): { chip: string; icon: string; text: string } {
  const palette = [
    {
      chip: "border-cyan/25 bg-cyan/[0.08] text-cyan",
      icon: "text-cyan",
      text: "text-cyan",
    },
    {
      chip: "border-amber/25 bg-amber/[0.08] text-amber",
      icon: "text-amber",
      text: "text-amber",
    },
    {
      chip: "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300",
      icon: "text-emerald-300",
      text: "text-emerald-300",
    },
    {
      chip: "border-fuchsia-400/25 bg-fuchsia-400/[0.08] text-fuchsia-300",
      icon: "text-fuchsia-300",
      text: "text-fuchsia-300",
    },
    {
      chip: "border-sky-400/25 bg-sky-400/[0.08] text-sky-300",
      icon: "text-sky-300",
      text: "text-sky-300",
    },
    {
      chip: "border-rose-400/25 bg-rose-400/[0.08] text-rose-300",
      icon: "text-rose-300",
      text: "text-rose-300",
    },
  ];
  const numericId = Number(speakerId);
  const index = Number.isInteger(numericId) && numericId > 0
    ? numericId - 1
    : Array.from(speakerId).reduce((sum, char) => sum + char.charCodeAt(0), 0);

  return palette[index % palette.length];
}

function LoadingText({ children }: { children: ReactNode }) {
  return <span className="shiny-loading-text">{children}</span>;
}

function TaggedText({
  activeSearchMatchIndex = -1,
  searchMatchStartIndex = -1,
  searchQuery = "",
  text,
}: {
  activeSearchMatchIndex?: number;
  searchMatchStartIndex?: number;
  searchQuery?: string;
  text: string;
}) {
  const query = searchQuery.trim();
  const parts = query ? splitSearchMatches(text, query) : [{ highlight: false, text }];
  let matchOffset = 0;

  return parts.map((part, partIndex) => {
    if (part.highlight) {
      const currentMatchIndex = searchMatchStartIndex + matchOffset;
      const isActiveMatch = searchMatchStartIndex >= 0 && currentMatchIndex === activeSearchMatchIndex;
      matchOffset += 1;

      return (
        <span
          key={`match-${partIndex}-${part.text.slice(0, 8)}`}
          className={cn(
            "rounded-[0.28rem] px-1 py-[0.08rem] text-inherit box-decoration-clone",
            isActiveMatch
              ? "bg-[rgb(184_137_55_/_0.88)] shadow-[inset_0_0_0_1px_rgba(241,207,132,0.34)]"
              : "bg-[rgb(124_89_56_/_0.78)] shadow-[inset_0_0_0_1px_rgba(197,160,118,0.2)]",
          )}
        >
          {part.text}
        </span>
      );
    }

    return renderSocialTokens(part.text, "body", `part-${partIndex}`);
  });
}

function renderSocialTokens(text: string, variant: "body" | "title", keyPrefix = "token"): ReactNode[] {
  return text.split(SOCIAL_TOKEN_PATTERN).map((token, index) => {
    if (!token) {
      return null;
    }

    if (token.startsWith("#")) {
      return (
        <span key={`${keyPrefix}-${index}-${token}`} className={socialTokenClassName("hashtag", variant)}>
          {token}
        </span>
      );
    }

    if (token.startsWith("@")) {
      return (
        <span key={`${keyPrefix}-${index}-${token}`} className={socialTokenClassName("mention", variant)}>
          {token}
        </span>
      );
    }

    return <span key={`${keyPrefix}-${index}-${token.slice(0, 8)}`}>{token}</span>;
  });
}

function socialTokenClassName(kind: "hashtag" | "mention", variant: "body" | "title"): string {
  if (variant === "title") {
    return kind === "hashtag" ? "text-amber" : "text-cyan";
  }

  return kind === "hashtag"
    ? "mx-0.5 inline-flex rounded-sm border border-[#9bb892]/20 bg-[#9bb892]/10 px-1.5 py-0.5 text-[#adc4a3]"
    : "mx-0.5 inline-flex rounded-sm border border-cyan/20 bg-cyan/[0.08] px-1.5 py-0.5 text-cyan";
}

function splitSearchMatches(text: string, query: string): Array<{ highlight: boolean; text: string }> {
  const source = text.toLocaleLowerCase();
  const target = query.toLocaleLowerCase();
  const parts: Array<{ highlight: boolean; text: string }> = [];
  let cursor = 0;
  let matchIndex = source.indexOf(target);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push({ highlight: false, text: text.slice(cursor, matchIndex) });
    }

    const matchEnd = matchIndex + query.length;
    parts.push({ highlight: true, text: text.slice(matchIndex, matchEnd) });
    cursor = matchEnd;
    matchIndex = source.indexOf(target, cursor);
  }

  if (cursor < text.length) {
    parts.push({ highlight: false, text: text.slice(cursor) });
  }

  return parts;
}
