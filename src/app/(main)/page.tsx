"use client";

import Image from "next/image";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  AudioLines,
  ChevronDown,
  ChevronUp,
  Check,
  Copy,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Info,
  Languages,
  Link2,
  LogIn,
  LogOut,
  Loader2,
  Pause,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  Save,
  ScanText,
  Search,
  Settings,
  Sparkles,
  Trash2,
  UserRound,
  Volume2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  type FormEvent,
  type Dispatch,
  Fragment,
  type ReactNode,
  type SetStateAction,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  TRANSCRIPT_FEATURE,
  type DouyinKind,
  type ExtractionResult,
  type MediaAssetKind,
  type ResultFeature,
  type ResolvedDouyinWork,
  type TranscriptSegment,
} from "@/types/douyin";
import { SUMMARY_PROMPTS, type SummaryPrompt } from "@/lib/ai/prompts";
import { estimateMediaProcessingDurationSeconds } from "@/lib/douyin/cache-estimate";
import { buildMediaDownloadPath } from "@/lib/douyin/download";
import { stripTrailingDouyinWatermarkFromTranscript } from "@/lib/transcript/normalize";
import { cn } from "@/lib/utils";

type ApiError = {
  error: string;
  code?: string;
  retryAfter?: number;
};

type ApiPayload = ApiError | { results: ExtractionResult[]; status: "failed" | "succeeded"; work?: ResolvedDouyinWork } | { translation?: string } | { work?: ResolvedDouyinWork };
type TranscribeApiPayload =
  | ApiError
  | { jobId: string; status: "running"; work?: ResolvedDouyinWork }
  | { results: ExtractionResult[]; status: "failed" | "succeeded"; work?: ResolvedDouyinWork };
type TranslationPayload = ApiError;
type SegmentTranslation = {
  error?: string;
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
  | { type: "segment_done"; key: string; value: string }
  | { type: "segment_error"; key: string; error: string }
  | { type: "done" }
  | { type: "error"; error: string; code?: string };
type SummaryStreamEvent =
  | { type: "delta"; value: string }
  | { type: "done"; value: string }
  | { type: "error"; error: string; code?: string };
type TranscribeStreamEvent =
  | { type: "running"; jobId: string; work?: ResolvedDouyinWork }
  | { type: "postprocess_start"; work?: ResolvedDouyinWork }
  | { type: "delta"; value: string }
  | { type: "done"; results: ExtractionResult[]; status: "succeeded"; work?: ResolvedDouyinWork }
  | { type: "error"; error: string; code?: string; retryAfter?: number; resetAt?: string; work?: ResolvedDouyinWork };
type TranscribeStreamOutcome =
  | { type: "done" }
  | { type: "running"; jobId: string };
type CurrentUser = {
  email: string;
  id: string;
  username: string;
};
type CachedMediaAsset = {
  asrAudioObjectKey?: string;
  asrAudioUrl?: string;
  downloadName: string;
  error?: string;
  isLoading: boolean;
  url?: string;
  workKey: string;
};

type ClipboardDouyinInput = {
  tags: string[];
  text: string;
  url: string;
};

type SpeakerOption = {
  id: string;
  label: string;
};
type AsrModelId = "e1" | "e2";
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

function getAvatarInitial(user: CurrentUser): string {
  const source = (user.username || user.email).trim();
  const initial = Array.from(source)[0] ?? "?";
  return /^[a-z]$/i.test(initial) ? initial.toLocaleUpperCase("en-US") : initial;
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
    throw new Error("error" in payload ? payload.error : "设置保存失败。");
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
  if (error.name === "AbortError") {
    return "请求超时，请稍后重试。";
  }
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(error.message)) {
    return "网络连接异常，请检查网络后重试。";
  }
  if (/非 JSON 响应|JSON 格式无效|HTTP 5\d\d|服务响应异常/.test(error.message)) {
    return "服务暂时不可用，请稍后重试。";
  }

  return error.message || fallback;
}

function throwApiError(payload: ApiError | undefined, fallback: string): never {
  const error = new Error(payload?.error || fallback) as Error & { code?: string };
  error.code = payload?.code;
  throw error;
}

function isLinkHintResolveError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as Error & { code?: string }).code;
  return code === "invalid_url" ||
    code === "no_url" ||
    code === "unsupported_host" ||
    code === "unsupported_type";
}

async function streamTranslationContent(input: {
  items: Array<{ key: string; text: string }>;
  onDelta: (key: string, delta: string) => void;
  onDone: (key: string, text: string) => void;
  onError: (key: string, error: string) => void;
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
    const payload = (await readApiPayload(response, "翻译失败。")) as TranslationPayload;
    if (isUnauthenticatedApiResponse(response, payload)) {
      throw new AuthRequiredError();
    }
    throw new Error("error" in payload ? payload.error : "翻译失败。");
  }

  for await (const event of readJsonEventStream<TranslationStreamEvent>(response.body)) {
    if (event.type === "delta") {
      input.onDelta(event.key, event.value);
    } else if (event.type === "segment_done") {
      input.onDone(event.key, event.value);
    } else if (event.type === "segment_error") {
      input.onError(event.key, event.error);
    } else if (event.type === "error") {
      throw new Error(event.error);
    }
  }
}

async function streamSummaryContent(input: {
  onDelta: (delta: string) => void;
  onDone: (text: string) => void;
  prompt: string;
  text: string;
}): Promise<void> {
  const response = await fetch("/api/douyin/summarize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: input.prompt, text: input.text }),
  });

  if (!response.ok || !response.body) {
    const payload = await readApiPayload(response, "AI处理失败。");
    if (isUnauthenticatedApiResponse(response, payload)) {
      throw new AuthRequiredError();
    }
    throw new Error("error" in payload ? payload.error : "AI处理失败。");
  }

  for await (const event of readJsonEventStream<SummaryStreamEvent>(response.body)) {
    if (event.type === "delta") {
      input.onDelta(event.value);
    } else if (event.type === "done") {
      input.onDone(event.value);
    } else if (event.type === "error") {
      throw new Error(event.error);
    }
  }
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

async function readClipboardDouyinInput(): Promise<ClipboardDouyinInput | null> {
  if (typeof window === "undefined" || !window.isSecureContext || !navigator.clipboard?.readText) {
    return null;
  }

  try {
    const value = (await navigator.clipboard.readText()).trim();
    const douyinInput = extractDouyinInput(value);
    return value.length <= CLIPBOARD_INPUT_LIMIT && douyinInput
      ? { text: value, ...douyinInput }
      : null;
  } catch {
    return null;
  }
}

function isSameDouyinInput(current: string, next: ClipboardDouyinInput): boolean {
  const currentInput = extractDouyinInput(current);
  if (!currentInput) {
    return false;
  }

  return currentInput.url === next.url || areSameTags(currentInput.tags, next.tags);
}

function extractDouyinInput(value: string): Pick<ClipboardDouyinInput, "tags" | "url"> | null {
  const match = value.match(URL_PATTERN);
  if (!match) {
    return null;
  }

  const urlText = match[0].replace(TRAILING_URL_PUNCTUATION_PATTERN, "");
  try {
    const hostname = new URL(urlText).hostname;
    return hostname === "douyin.com" || hostname.endsWith(".douyin.com")
      ? { tags: extractTagsBeforeUrl(value, match.index ?? 0), url: urlText }
      : null;
  } catch {
    return null;
  }
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

const WORK_LINK_HINT = "未识别到可处理的抖音作品。请重新粘贴正确的作品分享链接，或直接粘贴作品 URL 地址。";
const CLIPBOARD_PRIVACY_HINT = "自动粘贴功能：检测到剪贴板最新记录包含抖音链接会自动填入输入框，但不会读取粘贴板历史记录，保护您的隐私。";
const URL_PATTERN = /https?:\/\/[^\s"'<>，。！？；、）】》\\]+/i;
const TRAILING_URL_PUNCTUATION_PATTERN = /[)\]}.,!?;:，。！？；：、]+$/u;
const TAG_PATTERN = /#\s*[\p{L}\p{N}_-]+/gu;
const SOCIAL_TOKEN_PATTERN = /([#@][\p{L}\p{N}_-]+)/gu;
const CLIPBOARD_INPUT_LIMIT = 5000;
const SPEAKER_COUNT_MIN = 1;
const SPEAKER_COUNT_MAX = 10;
const SUBTITLE_MAX_CHARS_PER_CUE = 84;
const SUBTITLE_MAX_LINE_LENGTH = 42;
const ASR_MODEL_PANEL_WIDTH = 220;
const TRANSCRIBE_POLL_INITIAL_DELAY_MS = 1_500;
const TRANSCRIBE_POLL_MAX_DELAY_MS = 5_000;
const TRANSCRIBE_POLL_TIMEOUT_MS = 10 * 60_000;
const ASSET_CACHE_RETRY_ATTEMPTS = 3;
const ASSET_CACHE_RETRY_BASE_DELAY_MS = 800;
const AUTO_RESOLVE_DELAY_MS = 350;
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
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default function HomePage() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [work, setWork] = useState<ResolvedDouyinWork | null>(null);
  const [results, setResults] = useState<ExtractionResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasAcceptedUsage, setHasAcceptedUsage] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [asrModel, setAsrModel] = useState<AsrModelId>("e1");
  const [qwenAsrItnEnabled, setQwenAsrItnEnabled] = useState(false);
  const [speakerDiarizationEnabled, setSpeakerDiarizationEnabled] = useState(false);
  const [speakerCount, setSpeakerCount] = useState("");
  const [specialWordFilterEnabled, setSpecialWordFilterEnabled] = useState(false);
  const [specialWordFilterPanelOpen, setSpecialWordFilterPanelOpen] = useState(false);
  const [signedFilterWords, setSignedFilterWords] = useState("");
  const [emptyFilterWords, setEmptyFilterWords] = useState("");
  const [systemReservedFilter, setSystemReservedFilter] = useState(true);
  const [pendingTranscribeJobId, setPendingTranscribeJobId] = useState("");
  const [transcribeStatusMessage, setTranscribeStatusMessage] = useState("");
  const [lastResolvedInput, setLastResolvedInput] = useState("");
  const [currentUser, setCurrentUser] = useState<CurrentUser | null | undefined>(undefined);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const isReadingClipboardRef = useRef(false);
  const resolveRequestIdRef = useRef(0);
  const transcribeRequestIdRef = useRef(0);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const redirectToLogin = useCallback(() => {
    setError(null);
    const next = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`;
    router.push(`/login?next=${encodeURIComponent(next || "/")}`);
  }, [router]);
  const cachedAssets = useWorkAssetCache(work, redirectToLogin);

  const normalizedInput = input.trim();
  const isInputDirty = Boolean(work && normalizedInput !== lastResolvedInput);
  const activeKind = hasAcceptedUsage && work && !isInputDirty ? work.kind : null;
  const displayWork = activeKind ? work : null;
  const activeWorkKey = displayWork ? `${displayWork.kind}:${displayWork.id}` : "";
  const originalAudioCache = activeKind === "video" && cachedAssets.originalAudio?.workKey === activeWorkKey
    ? cachedAssets.originalAudio
    : undefined;
  const isOriginalAudioReady = Boolean(
    originalAudioCache?.url &&
    originalAudioCache.asrAudioUrl &&
    originalAudioCache.asrAudioObjectKey &&
    !originalAudioCache.isLoading,
  );
  const isOriginalAudioPreparing = activeKind === "video" && (!originalAudioCache || originalAudioCache.isLoading);
  const originalAudioError = activeKind === "video" && originalAudioCache?.error && !originalAudioCache.url
    ? originalAudioCache.error
    : "";
  const visibleResults = useMemo(
    () => results.filter((result) => result.feature === TRANSCRIPT_FEATURE),
    [results],
  );
  const canTranscribe = Boolean(
    hasAcceptedUsage &&
    work?.kind === "video" &&
    !isInputDirty &&
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
  const supportsQwenAsrOptions = asrModel === "e1";
  const supportsAsrEnhancementOptions = asrModel === "e2";
  const signedFilterWordList = useMemo(() => parseSpecialWordInput(signedFilterWords), [signedFilterWords]);
  const emptyFilterWordList = useMemo(() => parseSpecialWordInput(emptyFilterWords), [emptyFilterWords]);
  const specialWordFilter = specialWordFilterEnabled && supportsAsrEnhancementOptions
    ? buildSpecialWordFilterRequest({
        emptyWords: emptyFilterWordList,
        signedWords: signedFilterWordList,
        systemReservedFilter,
      })
    : undefined;
  const canStartTranscribe = canTranscribe &&
    (!speakerDiarizationEnabled || !supportsAsrEnhancementOptions || hasValidSpeakerCount);
  const hasPendingTranscribeJob = Boolean(pendingTranscribeJobId);
  const transcribeActionLabel = hasPendingTranscribeJob ? "获取结果" : "转录文本";
  const canRunTranscribeAction = hasPendingTranscribeJob
    ? Boolean(
        hasAcceptedUsage &&
        work?.kind === "video" &&
        !isInputDirty &&
        !isTranscribing,
      )
    : canStartTranscribe;

  const ensureAuthenticated = useCallback((): boolean => {
    if (currentUser !== null) {
      return true;
    }

    redirectToLogin();
    return false;
  }, [currentUser, redirectToLogin]);

  function updateSpecialWordFilterEnabled(checked: boolean) {
    setSpecialWordFilterEnabled(checked);
    setSpecialWordFilterPanelOpen(checked);
  }

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

    function closeUserMenu(event: PointerEvent) {
      if (userMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setUserMenuOpen(false);
    }

    function closeUserMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeUserMenu);
    document.addEventListener("keydown", closeUserMenuOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeUserMenu);
      document.removeEventListener("keydown", closeUserMenuOnEscape);
    };
  }, [userMenuOpen]);

  const resolveInput = useCallback(async (value: string, options?: { showLinkHint?: boolean; silent?: boolean }) => {
    const valueToResolve = value.trim();
    const requestId = resolveRequestIdRef.current + 1;
    resolveRequestIdRef.current = requestId;

    if (!valueToResolve) {
      setError("请输入抖音分享链接。");
      return;
    }

    if (!ensureAuthenticated()) {
      return;
    }

    setIsResolving(true);
    if (!options?.silent) {
      setError(null);
    }

    try {
      const response = await fetch("/api/douyin/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: valueToResolve }),
      });
      const payload = await readApiPayload(response, "识别链接失败。");
      if (isUnauthenticatedApiResponse(response, payload)) {
        throw new AuthRequiredError();
      }

      if (!response.ok || !("work" in payload) || !payload.work) {
        throwApiError("error" in payload ? payload : undefined, "识别链接失败。");
      }

      if (requestId !== resolveRequestIdRef.current) {
        return;
      }
      setLastResolvedInput(valueToResolve);
      setWork(payload.work);
      setResults([]);
      setError(null);
    } catch (resolveError) {
      if (requestId !== resolveRequestIdRef.current) {
        return;
      }
      setWork(null);
      setResults([]);
      if (isAuthRequiredError(resolveError)) {
        redirectToLogin();
        return;
      }
      if (!options?.silent) {
        setError(readUserFacingError(resolveError, "识别链接失败。"));
      } else if (options.showLinkHint && isLinkHintResolveError(resolveError)) {
        setError(WORK_LINK_HINT);
      }
    } finally {
      if (requestId === resolveRequestIdRef.current) {
        setIsResolving(false);
      }
    }
  }, [ensureAuthenticated, redirectToLogin]);

  useEffect(() => {
    let isActive = true;

    async function fillFromClipboard() {
      if (isReadingClipboardRef.current) {
        return;
      }

      isReadingClipboardRef.current = true;
      const clipboard = await readClipboardDouyinInput();
      isReadingClipboardRef.current = false;

      if (isActive && clipboard && !isSameDouyinInput(input, clipboard)) {
        setInput(clipboard.text);
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
  }, [input]);

  useEffect(() => {
    if (!hasAcceptedUsage || !normalizedInput || normalizedInput === lastResolvedInput || !extractDouyinInput(normalizedInput)) {
      return;
    }

    const timer = window.setTimeout(() => {
      void resolveInput(normalizedInput, { showLinkHint: true, silent: true });
    }, AUTO_RESOLVE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [hasAcceptedUsage, lastResolvedInput, normalizedInput, resolveInput]);

  async function transcribe() {
    if (!work || isInputDirty || isTranscribing) {
      return;
    }
    if (!ensureAuthenticated()) {
      return;
    }

    const requestId = transcribeRequestIdRef.current + 1;
    transcribeRequestIdRef.current = requestId;
    setIsTranscribing(true);
    setError(null);
    setTranscribeStatusMessage("");

    try {
      if (hasPendingTranscribeJob) {
        await pollPendingTranscribeResult(pendingTranscribeJobId, requestId);
        return;
      }

      if (!canStartTranscribe || !originalAudioCache?.asrAudioUrl || !originalAudioCache.asrAudioObjectKey) {
        return;
      }

      setTranscribeStatusMessage("正在提交转录任务...");
      const response = await fetch("/api/douyin/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audioObjectKey: originalAudioCache.asrAudioObjectKey,
          audioUrl: originalAudioCache.asrAudioUrl,
          diarizationEnabled: supportsAsrEnhancementOptions && speakerDiarizationEnabled,
          ...(supportsQwenAsrOptions && qwenAsrItnEnabled ? { enableItn: true } : {}),
          model: asrModel,
          specialWordFilter,
          speakerCount: effectiveSpeakerCount,
          work,
        }),
      });
      const outcome = await consumeTranscribeResponse(response, "转录失败。");
      if (outcome.type === "running") {
        setTranscribeStatusMessage("转录任务已提交，正在等待识别结果...");
        setResults([]);
        await pollPendingTranscribeResult(outcome.jobId, requestId);
      }
    } catch (transcribeError) {
      if (isAuthRequiredError(transcribeError)) {
        redirectToLogin();
        return;
      }
      setTranscribeStatusMessage("");
      setError(readUserFacingError(transcribeError, "转录失败。"));
    } finally {
      setIsTranscribing(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasAcceptedUsage) {
      setError("请先确认仅用于个人学习和非商业用途，并尊重原作者版权。");
      return;
    }
    if (!ensureAuthenticated()) {
      return;
    }

    void resolveInput(normalizedInput);
  }

  function updateUsageConsent(value: boolean) {
    setHasAcceptedUsage(value);
    if (value && error === "请先确认仅用于个人学习和非商业用途，并尊重原作者版权。") {
      setError(null);
    }
  }

  async function pollPendingTranscribeResult(jobId: string, requestId: number) {
    let elapsedMs = 0;
    let delayMs = TRANSCRIBE_POLL_INITIAL_DELAY_MS;
    setPendingTranscribeJobId(jobId);

    while (requestId === transcribeRequestIdRef.current) {
      const settled = await fetchPendingTranscribeResult(jobId);
      if (settled) {
        return;
      }

      if (elapsedMs >= TRANSCRIBE_POLL_TIMEOUT_MS) {
        setTranscribeStatusMessage("转录任务仍在处理中，稍后点击“获取结果”继续刷新。");
        return;
      }

      await sleep(delayMs);
      elapsedMs += delayMs;
      delayMs = Math.min(TRANSCRIBE_POLL_MAX_DELAY_MS, Math.round(delayMs * 1.35));
    }
  }

  async function fetchPendingTranscribeResult(jobId: string): Promise<boolean> {
    if (!jobId) {
      return false;
    }

    const response = await fetch(`/api/douyin/transcribe?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
    });
    const outcome = await consumeTranscribeResponse(response, "转录结果获取失败。");
    return outcome.type === "done";
  }

  async function consumeTranscribeResponse(response: Response, fallback: string): Promise<TranscribeStreamOutcome> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      const payload = await readApiPayload(response, fallback) as TranscribeApiPayload;
      if (isUnauthenticatedApiResponse(response, payload)) {
        throw new AuthRequiredError();
      }
      return applyTranscribePayload(response, payload, fallback);
    }

    for await (const event of readJsonEventStream<TranscribeStreamEvent>(response.body)) {
      if (event.type === "postprocess_start" || event.type === "delta") {
        setTranscribeStatusMessage("正在后处理优化转录结果...");
      } else if (event.type === "running") {
        const eventWork = event.work;
        if (eventWork) {
          setLastResolvedInput(normalizedInput);
          setWork((current) => mergeResolvedWork(current, eventWork));
        }
        setPendingTranscribeJobId(event.jobId);
        setTranscribeStatusMessage("转录任务处理中，完成后会自动展示结果...");
        return { type: "running", jobId: event.jobId };
      } else if (event.type === "done") {
        const eventWork = event.work;
        if (eventWork) {
          setWork((current) => mergeResolvedWork(current, eventWork));
        }
        setLastResolvedInput(normalizedInput);
        setPendingTranscribeJobId("");
        setTranscribeStatusMessage("");
        setResults(orderResults(event.results, [TRANSCRIPT_FEATURE]));
        return { type: "done" };
      } else if (event.type === "error") {
        throw new Error(event.error);
      }
    }

    throw new Error(fallback);
  }

  function applyTranscribePayload(
    response: Response,
    payload: TranscribeApiPayload,
    fallback: string,
  ): TranscribeStreamOutcome {
    const transcribedWork = "work" in payload ? payload.work : undefined;
    if (!response.ok) {
      throw new Error("error" in payload ? payload.error : fallback);
    }

    if ("results" in payload) {
      if (transcribedWork) {
        setWork((current) => mergeResolvedWork(current, transcribedWork));
      }
      setLastResolvedInput(normalizedInput);
      setPendingTranscribeJobId("");
      setTranscribeStatusMessage("");
      setResults(orderResults(payload.results, [TRANSCRIPT_FEATURE]));
      return { type: "done" };
    }

    if ("jobId" in payload) {
      if (transcribedWork) {
        setWork((current) => mergeResolvedWork(current, transcribedWork));
      }
      setLastResolvedInput(normalizedInput);
      setPendingTranscribeJobId(payload.jobId);
      setTranscribeStatusMessage("转录任务处理中，完成后会自动展示结果...");
      return { type: "running", jobId: payload.jobId };
    }

    throw new Error("error" in payload ? payload.error : fallback);
  }

  function updateInput(value: string) {
    const nextValue = value.trim();
    if (!nextValue || nextValue !== lastResolvedInput) {
      resolveRequestIdRef.current += 1;
      transcribeRequestIdRef.current += 1;
      setPendingTranscribeJobId("");
      setTranscribeStatusMessage("");
      setWork(null);
      setResults([]);
      setLastResolvedInput("");
    }
    setInput(value);
    if (!nextValue) {
      setError(null);
      return;
    }
  }

  function clearInput() {
    resolveRequestIdRef.current += 1;
    transcribeRequestIdRef.current += 1;
    setPendingTranscribeJobId("");
    setTranscribeStatusMessage("");
    setInput("");
    setWork(null);
    setResults([]);
    setLastResolvedInput("");
    setError(null);
  }

  async function logout() {
    setUserMenuOpen(false);
    await fetch("/api/auth/logout", { method: "POST" });
    setCurrentUser(null);
    router.refresh();
  }

  return (
    <main className="app-shell min-h-[100dvh] overflow-x-hidden bg-background text-foreground">
      <div className="relative z-10 mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-5 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 sm:px-5 sm:py-7 md:gap-7 md:py-10">
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
              <p className="truncate text-sm text-muted-foreground">透视抖音作品的声音与文字</p>
            </div>
          </div>
          <div className="absolute right-0 top-0">
            {currentUser ? (
              <div ref={userMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setUserMenuOpen((open) => !open)}
                  className="inline-flex size-11 select-none items-center justify-center rounded-full border border-white/10 bg-muted text-base font-semibold text-foreground shadow-[inset_0_1px_0_rgb(255_255_255_/_0.06)] transition hover:border-cyan/35 hover:bg-cyan/[0.12] hover:text-cyan active:scale-[0.96]"
                  aria-expanded={userMenuOpen}
                  aria-haspopup="menu"
                  aria-label={`${currentUser.username} 用户菜单`}
                  title={currentUser.username}
                >
                  {getAvatarInitial(currentUser)}
                </button>

                <aside
                  aria-hidden={!userMenuOpen}
                  className={cn(
                    "fixed right-0 top-0 z-40 flex h-[100dvh] w-[min(20rem,calc(100vw-1rem))] flex-col border-l border-white/12 bg-background/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] shadow-2xl shadow-black/40 backdrop-blur-xl transition duration-200 ease-out",
                    userMenuOpen
                      ? "pointer-events-auto translate-x-0 opacity-100"
                      : "pointer-events-none translate-x-full opacity-0",
                  )}
                  role="menu"
                >
                  <div className="mb-5 flex items-center gap-3 border-b border-white/10 pb-4">
                    <span className="inline-flex size-11 shrink-0 select-none items-center justify-center rounded-full border border-cyan/35 bg-cyan/[0.08] text-base font-semibold text-cyan">
                      {getAvatarInitial(currentUser)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{currentUser.username}</p>
                      <p className="truncate text-xs text-muted-foreground">{currentUser.email}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setUserMenuOpen(false)}
                      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-cyan active:scale-[0.96]"
                      aria-label="关闭用户面板"
                      title="关闭用户面板"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </div>

                  <div className="grid gap-1">
                    <button
                      type="button"
                      onClick={() => void logout()}
                      className="flex h-10 w-full items-center gap-2 rounded-md px-3 text-sm font-semibold text-destructive transition hover:bg-destructive/10 active:scale-[0.98]"
                      role="menuitem"
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

        <form onSubmit={submit} className="flex flex-col gap-2">
          <label className="order-1 flex min-w-0 cursor-pointer items-start gap-3 rounded-md bg-black/20 px-0 py-2 text-left md:order-2">
            <span className="relative mt-0.5 shrink-0">
              <input
                type="checkbox"
                checked={hasAcceptedUsage}
                onChange={(event) => updateUsageConsent(event.target.checked)}
                className="peer absolute inset-0 z-10 cursor-pointer opacity-0"
              />
              <span
                aria-hidden="true"
                className="flex size-[1.05rem] items-center justify-center rounded-[0.28rem] border border-white/28 bg-white/[0.03] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.06),0_0_0_1px_rgb(0_0_0_/_0.2)] transition peer-hover:border-cyan/55 peer-focus-visible:border-cyan/70 peer-focus-visible:ring-2 peer-focus-visible:ring-cyan/20 peer-checked:border-cyan/80 peer-checked:bg-white/[0.02] peer-checked:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08),0_0_0_1px_rgb(0_0_0_/_0.18),0_0_16px_rgb(34_211_238_/_0.12)] peer-checked:[&_svg]:opacity-100"
              >
                <Check className="size-[0.82rem] text-cyan opacity-0 drop-shadow-[0_0_6px_rgba(34,211,238,0.45)] transition duration-150 ease-out" strokeWidth={3.4} />
              </span>
            </span>
            <span className="mobile-readable min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
              我确认仅用于个人学习和非商业用途，并尊重原作者版权；已阅读并同意
              <Link
                href="/legal"
                className="mx-1 font-semibold text-cyan underline decoration-cyan/50 underline-offset-4 transition hover:text-amber hover:decoration-amber"
              >
                法律声明
              </Link>
            </span>
          </label>

          <div className="order-2 flex flex-col gap-3 md:order-1 md:flex-row md:items-center">
            <div
              className={cn(
                "flex min-h-14 flex-1 items-center gap-3 rounded-md border bg-black/20 px-4 transition",
                hasAcceptedUsage
                  ? "border-cyan/35 focus-within:border-cyan/80 focus-within:ring-2 focus-within:ring-cyan/20"
                  : "border-white/25",
              )}
            >
              <Link2 className={cn("size-5 shrink-0", hasAcceptedUsage ? "text-amber" : "text-muted-foreground")} />
              <span
                tabIndex={0}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-cyan/[0.08] hover:text-cyan focus-visible:bg-cyan/[0.08] focus-visible:text-cyan focus-visible:outline-none"
                aria-label={CLIPBOARD_PRIVACY_HINT}
                title={CLIPBOARD_PRIVACY_HINT}
              >
                <AlertCircle className="size-4" aria-hidden="true" />
              </span>
              <input
                value={input}
                onChange={(event) => updateInput(event.target.value)}
                disabled={!hasAcceptedUsage}
                className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                placeholder={hasAcceptedUsage ? "粘贴抖音作品的分享链接或者地址。" : "请先勾选使用确认。"}
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
              type="submit"
              disabled={!hasAcceptedUsage || isResolving || !normalizedInput}
              className="inline-flex h-12 w-full items-center justify-center rounded-md bg-cyan px-4 text-sm font-semibold text-black shadow-lg shadow-cyan/20 transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none md:w-auto"
            >
              {isResolving ? "检测中" : "智能检测"}
            </button>
          </div>
        </form>

        <section
          className={cn(
            "relative overflow-hidden rounded-lg border p-4 sm:p-5",
            activeKind
              ? "border-white/25 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.07)]"
              : "empty-link-state border-cyan/35",
          )}
        >
          {activeKind ? (
            <div className="mb-4 pb-2">
              <div className="flex flex-wrap items-start gap-x-5 gap-y-4 text-left text-sm xl:flex-nowrap">
                <dl className="contents">
                  <InfoRow className="w-24 shrink-0" label="作品类型" singleLine value={KIND_LABELS[activeKind]} />
                  <InfoRow
                    className="w-44 shrink-0"
                    label="作者"
                    singleLine
                    value={displayWork?.authorName ?? "未识别"}
                    href={displayWork?.authorUrl}
                  />
                  <InfoRow
                    className="w-48 shrink-0"
                    label="作品链接"
                    value={displayWork?.finalUrl ?? "未识别"}
                    href={displayWork?.finalUrl}
                    singleLine
                  />
                </dl>
                {displayWork ? <WorkDownloadActions cachedAssets={cachedAssets} work={displayWork} /> : null}
              </div>
              <WorkTitleRow title={displayWork?.title} />
            </div>
          ) : null}

          {activeKind ? null : (
            <div className="grid gap-3 md:grid-cols-3">
              <div className="relative z-10 flex min-h-36 flex-col items-center justify-center gap-2 p-6 text-center md:col-span-3">
                <div className="text-base font-semibold text-foreground">
                  {isResolving ? "正在识别作品" : "等待作品链接"}
                </div>
                <p className="mobile-readable max-w-md text-sm leading-6 text-muted-foreground">
                  {isResolving ? "正在识别视频作品。" : "粘贴视频链接后，EchoLens 会自动准备转录流程。"}
                </p>
              </div>
            </div>
          )}

          {error ? (
            <div className="mt-5 flex items-center justify-center gap-2 px-4 py-2 text-center text-sm text-destructive">
              <AlertCircle className="size-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

        </section>

        <section
          className="overflow-hidden rounded-lg border border-white/25 p-0 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.07)]"
        >
          {visibleResults.length > 0 ? (
            <div className="grid gap-5">
              {visibleResults.map((result) => (
                <ResultBlock key={result.feature} onAuthRequired={redirectToLogin} result={result} />
              ))}
            </div>
          ) : (
          <EmptyResults
            actionBusy={isTranscribing}
            actionDisabled={!canRunTranscribeAction}
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
                    {!isOriginalAudioReady ? (
                      <AudioCacheNotice
                        key={activeWorkKey}
                        error={originalAudioError}
                        isLoading={isOriginalAudioPreparing}
                        progressKey={activeWorkKey}
                        videoDurationSeconds={displayWork?.durationSeconds}
                      />
                    ) : null}
                    {hasPendingTranscribeJob ? (
                      <p className="mt-2 text-center text-xs text-muted-foreground">
                        <LoadingText>
                          {transcribeStatusMessage || "转录任务已提交，正在等待识别结果..."}
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
              onAction={activeKind === "video" ? transcribe : undefined}
            />
          )}
        </section>

        <LegalNoticeFooter />
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

function EmptyResults({
  actionBusy,
  actionDisabled,
  actionLabel,
  actionSlot,
  configSlot,
  modelSlot,
  notice,
  onAction,
}: {
  actionBusy: boolean;
  actionDisabled: boolean;
  actionLabel: string;
  actionSlot?: ReactNode;
  configSlot?: ReactNode;
  modelSlot?: ReactNode;
  notice?: ReactNode;
  onAction?: () => void;
}) {
  return (
    <div className={cn("empty-result-stage", configSlot ? "min-h-80" : "min-h-60")}>
      <div
        className="relative z-10 flex h-11 w-28 items-center justify-center text-cyan/75"
        aria-hidden="true"
      >
        <span className="h-px w-full bg-gradient-to-r from-transparent via-cyan/35 to-transparent" />
        <ScanText className="absolute size-5 drop-shadow-[0_0_10px_rgb(34_211_238_/_0.18)]" />
      </div>
      <p className="mobile-readable relative z-10 max-w-[34rem] text-center text-sm font-medium leading-6 text-foreground/85">
        使用Echolens，将任何抖音作品内容即时转化为有用的可视化笔记。
      </p>
      {notice ? <div className="relative z-10 mt-3 w-full max-w-[34rem]">{notice}</div> : null}
      <div className="absolute inset-x-4 bottom-4 z-20 grid gap-3">
        {configSlot ? <div className="min-w-0">{configSlot}</div> : null}
        <div className="grid min-w-0 gap-3 sm:flex sm:flex-wrap sm:items-center">
          <div className="min-w-0 sm:flex-1">{actionSlot}</div>
          <div className="grid min-w-0 gap-2 sm:ml-auto sm:flex sm:shrink-0 sm:items-center sm:gap-3">
            <div className="min-w-0">{modelSlot}</div>
            <button
              type="button"
              onClick={() => onAction?.()}
              disabled={actionDisabled || !onAction}
              className={cn(
                "inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed sm:w-auto",
                actionDisabled || !onAction
                  ? "bg-white/[0.055] text-muted-foreground"
                  : "bg-cyan text-black shadow-lg shadow-cyan/15 hover:brightness-110",
              )}
            >
              {actionBusy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {actionLabel}
            </button>
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
      <CompactSwitch
        checked={specialWordFilterEnabled}
        disabled={disabled || !supportsEnhancementOptions}
        label="敏感词过滤"
        onChange={onSpecialWordFilterCheckedChange}
      />
      {specialWordFilterEnabled && supportsEnhancementOptions ? (
        <button
          type="button"
          onClick={onSpecialWordFilterPanelOpen}
          disabled={disabled}
          className="inline-flex h-6 items-center rounded-md px-1.5 text-xs font-medium text-cyan transition hover:bg-cyan/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          配置
        </button>
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
      const left = Math.max(viewportPadding, buttonRect.left - width - gap);
      const top = Math.max(viewportPadding, buttonRect.top - gap - panelRect.height);

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
        className="inline-flex h-8 w-[5.8rem] items-center justify-between gap-1.5 rounded-sm bg-transparent px-2 text-sm font-semibold text-foreground transition hover:text-cyan disabled:cursor-not-allowed disabled:opacity-50"
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
                      selectedOption ? "bg-cyan/[0.1] text-cyan" : "text-foreground hover:bg-white/[0.06]",
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
    <div className="mt-4 min-w-0 text-left">
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
  isLoading,
  progressKey,
  videoDurationSeconds,
}: {
  error: string;
  isLoading: boolean;
  progressKey: string;
  videoDurationSeconds?: number;
}) {
  const estimatedSeconds = estimateMediaProcessingDurationSeconds(videoDurationSeconds);
  const hasEstimatedProgress = isLoading && estimatedSeconds !== null;
  const progress = useEstimatedProgress(hasEstimatedProgress, (estimatedSeconds ?? 0) * 1000, progressKey);
  const message = error || (hasEstimatedProgress && progress >= 99
    ? "正在缓存作品资源，稍后即可转录文本"
    : "正在缓存并抽取音频，加载完成后才能提取");

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
        </div>
        {hasEstimatedProgress ? (
          <div className="flex w-full items-center gap-2">
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="audio-cache-progress-fill h-full rounded-full bg-cyan shadow-[0_0_12px_rgba(34,211,238,0.35)]"
                style={{
                  "--audio-cache-progress": Math.max(0.01, progress / 100),
                  animationDuration: `${estimatedSeconds}s`,
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
  const [progress, setProgress] = useState(isLoading ? 1 : 0);

  useEffect(() => {
    if (!isLoading) {
      return;
    }

    const startedAt = performance.now();
    const safeEstimatedMs = Math.max(1_000, estimatedMs);
    let frameId = 0;
    let displayedProgress = -1;

    const updateProgress = () => {
      const ratio = Math.min(1, (performance.now() - startedAt) / safeEstimatedMs);
      const nextProgress = Math.min(99, Math.max(1, Math.floor(ratio * 99)));

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

function HighlightedTitle({ text }: { text: string }) {
  return renderSocialTokens(text, "title");
}

function InfoRow({
  className,
  label,
  value,
  singleLine,
  href,
}: {
  className?: string;
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
          {value !== "未识别" ? (
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

function useWorkAssetCache(
  work: ResolvedDouyinWork | null,
  onAuthRequired: () => void,
): Partial<Record<MediaAssetKind, CachedMediaAsset>> {
  const [cachedAssets, setCachedAssets] = useState<Partial<Record<MediaAssetKind, CachedMediaAsset>>>({});
  const objectUrlsRef = useRef<string[]>([]);
  const workId = work?.id ?? "";
  const workKind = work?.kind;
  const workKey = workKind && workId ? `${workKind}:${workId}` : "";
  const cacheWork = useMemo(() => workKind && workId ? { id: workId, kind: workKind } : null, [workId, workKind]);
  const actions = useMemo(() => cacheWork ? DOWNLOAD_ACTIONS : [], [cacheWork]);

  useEffect(() => {
    if (!cacheWork) {
      return;
    }

    const controller = new AbortController();
    const cacheRunId = createCacheRunId();
    const objectUrls: string[] = [];
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current = objectUrls;

    queueMicrotask(() => {
      if (controller.signal.aborted) {
        return;
      }

      setCachedAssets((current) => {
        const next = { ...current };
        for (const action of actions) {
          next[action.asset] = {
            downloadName: buildCachedAssetFilename(cacheWork, action.asset),
            isLoading: true,
            workKey,
          };
        }
        return next;
      });
    });

    void cacheAssetsInOrder(
      actions,
      cacheWork,
      workKey,
      cacheRunId,
      controller.signal,
      objectUrls,
      setCachedAssets,
      onAuthRequired,
    );

    return () => {
      controller.abort();
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current = [];
    };
  }, [actions, cacheWork, onAuthRequired, workKey]);

  return cachedAssets;
}

function createCacheRunId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function cacheAssetsInOrder(
  actions: typeof DOWNLOAD_ACTIONS,
  cacheWork: Pick<ResolvedDouyinWork, "id" | "kind">,
  workKey: string,
  cacheRunId: string,
  signal: AbortSignal,
  objectUrls: string[],
  setCachedAssets: Dispatch<SetStateAction<Partial<Record<MediaAssetKind, CachedMediaAsset>>>>,
  onAuthRequired: () => void,
): Promise<void> {
  let videoCacheError = "";

  for (const action of actions) {
    if (action.asset === "originalAudio" && videoCacheError) {
      setAssetCacheError(
        setCachedAssets,
        cacheWork,
        action.asset,
        workKey,
        "视频资源缓存失败，已停止原声音频缓存。",
      );
      continue;
    }

    try {
      const cached = await cacheAsset(cacheWork, workKey, cacheRunId, action.asset, signal);
      if (signal.aborted) {
        URL.revokeObjectURL(cached.url);
        return;
      }
      objectUrls.push(cached.url);
      setCachedAssets((current) => ({
        ...current,
        [action.asset]: cached,
      }));
    } catch (error: unknown) {
      if (signal.aborted) {
        return;
      }
      if (isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      const errorMessage = readUserFacingError(error, "资源缓存失败。");
      if (action.asset === "video") {
        videoCacheError = errorMessage;
      }
      setAssetCacheError(setCachedAssets, cacheWork, action.asset, workKey, errorMessage);
    }
  }
}

function setAssetCacheError(
  setCachedAssets: Dispatch<SetStateAction<Partial<Record<MediaAssetKind, CachedMediaAsset>>>>,
  cacheWork: Pick<ResolvedDouyinWork, "id" | "kind">,
  asset: MediaAssetKind,
  workKey: string,
  error: string,
): void {
  setCachedAssets((current) => ({
    ...current,
    [asset]: {
      downloadName: buildCachedAssetFilename(cacheWork, asset),
      error,
      isLoading: false,
      workKey,
    },
  }));
}

function WorkDownloadActions({
  cachedAssets,
  work,
}: {
  cachedAssets: Partial<Record<MediaAssetKind, CachedMediaAsset>>;
  work: ResolvedDouyinWork;
}) {
  const workKey = `${work.kind}:${work.id}`;
  const actions = DOWNLOAD_ACTIONS;
  const [preview, setPreview] = useState<(typeof actions)[number] | null>(null);

  const previewCache = preview ? cachedAssets[preview.asset] : undefined;
  const previewCached = previewCache?.workKey === workKey ? previewCache : undefined;

  return (
    <>
      {actions.map((action) => {
        const assetLabel = action.asset === "originalAudio" ? "音频" : action.label.replace("下载", "");
        const previewActionLabel = action.asset === "originalAudio" ? "试听" : "预览";
        const maybeCached = cachedAssets[action.asset];
        const cached = maybeCached?.workKey === workKey ? maybeCached : undefined;
        const isCaching = !cached || cached.isLoading;
        const hasCacheError = Boolean(cached?.error && !cached.url);
        const cacheTitle = cached?.error ?? (isCaching ? "正在准备资源" : action.previewLabel);

        return (
          <div
            key={action.asset}
            className="w-[calc(50%_-_0.625rem)] min-w-32 shrink-0 text-left sm:w-32"
          >
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">{assetLabel}</div>
            <div className="flex min-h-8 min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPreview(action)}
                disabled={isCaching || hasCacheError}
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
              {isCaching || hasCacheError || !cached?.url ? (
                <button
                  type="button"
                  disabled
                  className="inline-flex h-7 w-14 shrink-0 items-center justify-center gap-1 rounded-md text-xs font-semibold text-muted-foreground opacity-60"
                  title={cached?.error ?? "正在准备资源"}
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  下载
                </button>
              ) : (
                <a
                  href={cached.url}
                  download={cached.downloadName}
                  className="inline-flex h-7 w-14 shrink-0 items-center justify-center gap-1 rounded-md text-xs font-semibold text-cyan transition hover:text-amber active:scale-[0.96]"
                  title={action.label}
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  下载
                </a>
              )}
            </div>
          </div>
        );
      })}
      {preview && previewCached?.url ? (
        <AssetPreviewDialog
          action={preview}
          previewUrl={previewCached.url}
          downloadName={previewCached?.downloadName}
          downloadUrl={previewCached.url}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  );
}

async function cacheAsset(
  work: Pick<ResolvedDouyinWork, "id" | "kind">,
  workKey: string,
  cacheRunId: string,
  asset: MediaAssetKind,
  signal: AbortSignal,
): Promise<CachedMediaAsset & { url: string }> {
  const response = await fetchCacheAssetResponse(buildMediaDownloadPath(work, asset, { cacheRunId }), signal);

  if (!response.ok) {
    if (response.status === 401) {
      const payload = await readJsonError(response);
      if (isUnauthenticatedApiResponse(response, payload)) {
        throw new AuthRequiredError();
      }
      throw new Error(payload?.error ?? "请先登录后再使用。");
    }
    throw new Error(await readCacheAssetError(response));
  }

  const blob = await response.blob();
  return {
    ...readAsrAudioHeaders(response, asset),
    downloadName: buildCachedAssetFilename(work, asset, blob.type),
    isLoading: false,
    url: URL.createObjectURL(blob),
    workKey,
  };
}

async function fetchCacheAssetResponse(url: string, signal: AbortSignal): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= ASSET_CACHE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal,
      });
      if (!isRetryableCacheStatus(response.status) || attempt === ASSET_CACHE_RETRY_ATTEMPTS) {
        return response;
      }

      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (signal.aborted || !isRetryableCacheFetchError(error) || attempt === ASSET_CACHE_RETRY_ATTEMPTS) {
        throw error;
      }
    }

    await sleep(ASSET_CACHE_RETRY_BASE_DELAY_MS * attempt);
  }

  throw lastError instanceof Error ? lastError : new Error("资源缓存失败。");
}

function isRetryableCacheStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isRetryableCacheFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }

  return error.name !== "AbortError" &&
    /fetch failed|network|socket|timeout|timed out|premature close|terminated|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/i.test(error.message);
}

async function readCacheAssetError(response: Response): Promise<string> {
  const fallback = formatHttpError(response.status, "资源缓存失败。");
  const payload = await readJsonError(response);
  if (payload) {
    return payload.error ? `资源缓存失败：${payload.error}` : fallback;
  }

  return fallback;
}

async function readJsonError(response: Response): Promise<Partial<ApiError> | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return null;
  }

  try {
    const payload = await response.json() as Partial<ApiError>;
    return payload;
  } catch {
    return null;
  }
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
  if (contentType.includes("mp4")) {
    return "mp4";
  }

  return asset === "cover" ? "jpg" : asset === "originalAudio" ? "wav" : "mp4";
}

function AssetPreviewDialog({
  action,
  downloadName,
  previewUrl,
  downloadUrl,
  onClose,
}: {
  action: (typeof DOWNLOAD_ACTIONS)[number];
  downloadName?: string;
  previewUrl: string;
  downloadUrl: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const canCopyCover = action.asset === "cover";

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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-sm sm:items-center sm:px-4 sm:py-6">
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
            <a
              href={downloadUrl}
              download={downloadName}
              className="inline-flex size-8 items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.08] hover:text-amber"
              aria-label={action.label}
              title={action.label}
            >
              <Download className="size-4" aria-hidden="true" />
            </a>
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
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [gain, setGain] = useState(1);

  useEffect(() => {
    return () => {
      void audioContextRef.current?.close();
      audioContextRef.current = null;
      gainNodeRef.current = null;
      sourceNodeRef.current = null;
    };
  }, []);

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
    if (audio?.muted) {
      setGain(0);
    }
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (audio.paused) {
      const audioContext = ensureAudioGraph();
      if (audioContext?.state === "suspended") {
        await audioContext.resume();
      }
      await audio.play();
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
    const nextGain = Math.min(2, Math.max(0, Number(value)));
    setGain(nextGain);
    if (!audio) {
      return;
    }
    audio.volume = 1;
    audio.muted = nextGain === 0;

    const audioContext = ensureAudioGraph();
    if (audioContext?.state === "suspended") {
      void audioContext.resume();
    }
    gainNodeRef.current?.gain.setValueAtTime(nextGain, audioContext?.currentTime ?? 0);
  }

  function ensureAudioGraph(): AudioContext | null {
    const audio = audioRef.current;
    if (!audio) {
      return null;
    }

    const audioContext = audioContextRef.current ?? new AudioContext();
    audioContextRef.current = audioContext;

    if (!sourceNodeRef.current) {
      try {
        const sourceNode = audioContext.createMediaElementSource(audio);
        const gainNode = audioContext.createGain();
        gainNode.gain.value = gain;
        sourceNode.connect(gainNode);
        gainNode.connect(audioContext.destination);
        sourceNodeRef.current = sourceNode;
        gainNodeRef.current = gainNode;
      } catch {
        return null;
      }
    }

    return audioContext;
  }

  return (
    <div className="relative rounded-md border border-cyan/15 bg-[linear-gradient(180deg,rgb(255_255_255_/_0.045),rgb(255_255_255_/_0.018))] p-3 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)] sm:p-4">
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
      <div className={cn("grid min-h-14 grid-cols-[auto_1fr_auto] items-center gap-3 transition-opacity duration-200 sm:flex", loaded && !error ? "opacity-100" : "opacity-0")}>
        <button
          type="button"
          onClick={() => void togglePlayback()}
          disabled={!loaded || Boolean(error)}
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-cyan/25 bg-cyan/10 text-cyan transition hover:bg-cyan/15 hover:text-amber active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={playing ? "暂停音频" : "播放音频"}
          title={playing ? "暂停" : "播放"}
        >
          {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
        </button>
        <span className="col-start-2 row-start-1 w-11 shrink-0 text-sm font-medium tabular-nums text-foreground/90">{formatMediaTime(currentTime)}</span>
        <input
          type="range"
          min="0"
          max={duration || 0}
          step="0.01"
          value={duration ? Math.min(currentTime, duration) : 0}
          onChange={(event) => seek(event.currentTarget.value)}
          disabled={!loaded || !duration}
          className="audio-progress col-span-3 row-start-2 h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-1 sm:row-auto"
          aria-label="音频播放进度"
        />
        <span className="col-start-3 row-start-1 w-11 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{formatMediaTime(duration)}</span>
        <div className="col-span-3 row-start-3 flex min-w-0 items-center justify-end gap-2 sm:col-span-1 sm:row-auto sm:w-32">
          <Volume2 className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
          <input
            type="range"
            min="0"
            max="2"
            step="0.01"
            value={gain}
            onChange={(event) => changeGain(event.currentTarget.value)}
            disabled={!loaded || Boolean(error)}
            className="audio-progress h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 sm:w-24 sm:flex-none"
            aria-label="音频增益"
          />
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
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
    authorUrl: next.authorUrl ?? current.authorUrl,
    durationSeconds: next.durationSeconds ?? current.durationSeconds,
    title: next.title ?? current.title,
  };
}

function ResultBlock({
  onAuthRequired,
  result,
}: {
  onAuthRequired: () => void;
  result: ExtractionResult;
}) {
  return (
    <article>
      {result.content ? (
        <TranscriptResultPanel key={result.feature} onAuthRequired={onAuthRequired} result={result} />
      ) : (
        <p className="flex min-h-24 items-center justify-center px-4 py-8 text-center text-sm text-muted-foreground">
          {result.detail ?? "没有返回内容。"}
        </p>
      )}
    </article>
  );
}

function TranscriptResultPanel({
  onAuthRequired,
  result,
}: {
  onAuthRequired: () => void;
  result: ExtractionResult;
}) {
  const normalizedResult = useMemo(() => stripTrailingDouyinWatermarkFromTranscript(result), [result]);
  const initialContent = normalizedResult.content ?? "";
  const canEditSpeakers = supportsTranscriptSpeakers(result.asrModel);
  const canUseSpeakerEmotion = supportsTranscriptSpeakerEmotion(result.asrModel);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);
  const [summaryMenuOpen, setSummaryMenuOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [summaryError, setSummaryError] = useState("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [customPrompts, setCustomPrompts] = useState<SummaryPrompt[]>([]);
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [customSpeakerIds, setCustomSpeakerIds] = useState<string[]>([]);
  const [segmentSpeakerOverrides, setSegmentSpeakerOverrides] = useState<Record<string, string | undefined>>({});
  const [speakerEditorTarget, setSpeakerEditorTarget] = useState<SpeakerEditorTarget | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const summaryMenuRef = useRef<HTMLDivElement | null>(null);
  const summaryScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isEditingContent || normalizedResult.content === undefined) {
      return;
    }
    setContent(normalizedResult.content);
    setEditedSegments(null);
    setEditedSubtitleCues(null);
  }, [isEditingContent, normalizedResult.content]);

  const usesOriginalSegments = content === (normalizedResult.content ?? initialContent);
  const segments = normalizeTranscriptSegments(content, editedSegments ?? (usesOriginalSegments ? normalizedResult.transcriptSegments : undefined));
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
  const activeSearchQuery = searchOpen ? trimmedSearchQuery : "";
  const activeSourceItems = isSubtitleMode ? subtitleCues : segments;
  const activeTranslations = isSubtitleMode ? subtitleTranslations : segmentTranslations;
  const searchMatches = useMemo(
    () => countSearchMatches(activeSourceItems.map((item) => item.text).join("\n"), activeSearchQuery),
    [activeSearchQuery, activeSourceItems],
  );
  const selectedSearchMatchIndex = searchMatches > 0
    ? Math.min(activeSearchMatchIndex, searchMatches - 1)
    : 0;
  const searchMatchRanges = useMemo(
    () => buildSearchMatchRanges(activeSourceItems, activeSearchQuery),
    [activeSearchQuery, activeSourceItems],
  );
  const activeSearchSegmentIndex = useMemo(
    () => findSearchMatchSegmentIndex(searchMatchRanges, selectedSearchMatchIndex),
    [searchMatchRanges, selectedSearchMatchIndex],
  );
  const activeSearchContainerRef = useRef<HTMLDivElement | null>(null);
  const activeSearchMatchRef = useRef<HTMLDivElement | null>(null);
  const prompts = [...SUMMARY_PROMPTS, ...customPrompts];
  const hasSummaryOutput = isSummarizing || Boolean(summary || summaryError);
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
    if (!copyMenuOpen && !downloadMenuOpen && !summaryMenuOpen && !translationOptionsOpen && !translationSettingsOpen) {
      return;
    }

    function closeActionMenu(event: PointerEvent) {
      if (actionMenuRef.current?.contains(event.target as Node) || summaryMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setCopyMenuOpen(false);
      setDownloadMenuOpen(false);
      setSummaryMenuOpen(false);
      setTranslationOptionsOpen(false);
      setTranslationSettingsOpen(false);
      setTranslationTargetRequest(null);
    }

    document.addEventListener("pointerdown", closeActionMenu);
    return () => document.removeEventListener("pointerdown", closeActionMenu);
  }, [copyMenuOpen, downloadMenuOpen, summaryMenuOpen, translationOptionsOpen, translationSettingsOpen]);

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

  async function translateAll(targetLang: string) {
    const items = activeSourceItems;
    const options = buildTranslationOptions(translationConfig, targetLang);
    if (!options.ok) {
      setTranslationError(options.error);
      return;
    }

    setTranslationConfig((current) => ({ ...current, targetLang }));
    setTranslationError(null);
    setTranslationOptionsOpen(false);
    setTranslationTargetRequest(null);
    setCopyMenuOpen(false);
    setDownloadMenuOpen(false);
    const streamItems = items.map((item, index) => ({
      key: buildTimedTextKey(item, index),
      text: item.text,
    }));
    const loadingTranslations = Object.fromEntries(streamItems.map((item) => [
      item.key,
      { isLoading: true },
    ]));
    if (isSubtitleMode) {
      setSubtitleTranslations(loadingTranslations);
    } else {
      setSegmentTranslations(loadingTranslations);
    }

    try {
      const setTranslations = isSubtitleMode ? setSubtitleTranslations : setSegmentTranslations;
      await streamTranslationContent({
        items: streamItems,
        options: options.value,
        onDelta: (key, delta) => {
          setTranslations((current) => ({
            ...current,
            [key]: {
              isLoading: true,
              text: `${current[key]?.text ?? ""}${delta}`,
            },
          }));
        },
        onDone: (key, text) => {
          setTranslations((current) => ({
            ...current,
            [key]: { isLoading: false, text },
          }));
        },
        onError: (key, error) => {
          setTranslations((current) => ({
            ...current,
            [key]: { error, isLoading: false },
          }));
        },
      });
    } catch (error) {
      if (isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      if (isSubtitleMode) {
        setSubtitleTranslations({});
      } else {
        setSegmentTranslations({});
      }
      setTranslationError(readUserFacingError(error, "翻译失败。"));
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
      return;
    }

    setTranslationConfig((current) => ({ ...current, targetLang }));
    setTranslationError(null);
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
              text: `${current[key]?.text ?? ""}${delta}`,
            },
          }));
        },
        onDone: (key, text) => {
          setTranslations((current) => ({
            ...current,
            [key]: { isLoading: false, text },
          }));
        },
        onError: (key, error) => {
          setTranslations((current) => ({
            ...current,
            [key]: { error, isLoading: false },
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

  async function summarize(prompt: SummaryPrompt) {
    setSummaryMenuOpen(false);
    setSummary("");
    setSummaryError("");
    setIsSummarizing(true);

    try {
      await streamSummaryContent({
        text: content,
        prompt: prompt.prompt,
        onDelta: (delta) => setSummary((current) => current + delta),
        onDone: (text) => setSummary(text),
      });
    } catch (error) {
      if (isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      setSummaryError(readUserFacingError(error, "AI处理失败。"));
    } finally {
      setIsSummarizing(false);
    }
  }

  function saveCustomPrompt(title: string, prompt: string) {
    const customPrompt: SummaryPrompt = {
      description: prompt,
      id: `custom-${Date.now()}`,
      prompt,
      title,
    };
    setCustomPrompts((current) => [...current, customPrompt]);
    setPromptDialogOpen(false);
    void summarize(customPrompt);
  }

  function resetSummary() {
    setSummary("");
    setSummaryError("");
    setIsSummarizing(false);
  }

  function startEditingContent() {
    if (isSubtitleMode) {
      setDraftSubtitleCues(subtitleCues.map((cue) => ({ ...cue })));
    } else {
      setDraftSegments(segments.map((segment) => ({ ...segment })));
    }
    setIsEditingContent(true);
  }

  function saveContent() {
    if (isSubtitleMode) {
      const nextCues = draftSubtitleCues.map((cue) => ({
        ...cue,
        text: normalizeSubtitleText(cue.text),
      }));
      setEditedSubtitleCues(nextCues);
      setDraftSubtitleCues([]);
      setIsEditingContent(false);
      setSubtitleTranslations({});
      setTranslationError(null);
      return;
    }

    const nextSegments = draftSegments.map((segment) => ({
      ...segment,
      text: segment.text.trim(),
    }));
    setEditedSegments(nextSegments);
    setContent(nextSegments.map((segment) => segment.text).join("\n"));
    setDraftSegments([]);
    setIsEditingContent(false);
    setSegmentTranslations({});
    setEditedSubtitleCues(null);
    setSubtitleTranslations({});
    setTranslationError(null);
    resetSummary();
  }

  function cancelEditingContent() {
    setDraftSegments([]);
    setDraftSubtitleCues([]);
    setIsEditingContent(false);
  }

  function updateDraftSegment(index: number, text: string) {
    setDraftSegments((current) =>
      current.map((segment, segmentIndex) => segmentIndex === index ? { ...segment, text } : segment),
    );
  }

  function updateDraftSubtitleCue(index: number, text: string) {
    setDraftSubtitleCues((current) =>
      current.map((cue, cueIndex) => cueIndex === index ? { ...cue, text } : cue),
    );
  }

  function toggleSearch() {
    setSearchOpen((value) => !value);
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
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.82fr)]">
      <section className="flex min-w-0 flex-col overflow-hidden">
        <div className="grid min-h-[4.25rem] grid-cols-1 items-center gap-2 border-b border-white/10 px-3 py-2 md:grid-cols-[auto_minmax(13rem,1fr)_auto]">
          <div className="flex min-w-0 items-center gap-2">
            <TranscriptViewToggle mode={viewMode} onChange={changeViewMode} />
          </div>
          <div className="flex min-w-0 justify-start md:justify-center">
            <TranscriptSearchControl
              activeSearchQuery={activeSearchQuery}
              clearSearchQuery={clearSearchQuery}
              moveSearchMatch={moveSearchMatch}
              searchMatches={searchMatches}
              searchOpen={searchOpen}
              searchQuery={searchQuery}
              selectedSearchMatchIndex={selectedSearchMatchIndex}
              toggleSearch={toggleSearch}
              updateSearchQuery={updateSearchQuery}
            />
          </div>
          <div ref={actionMenuRef} className="flex min-w-0 flex-wrap items-center justify-start gap-1 md:justify-end">
            <div className="flex h-8 items-center gap-0.5">
              {isEditingContent ? (
                <>
                  <button
                    type="button"
                    onClick={saveContent}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-semibold text-cyan transition hover:bg-cyan/[0.08] hover:text-amber active:scale-[0.96]"
                    title="保存编辑"
                  >
                    <Save className="size-3.5" aria-hidden="true" />
                    保存
                  </button>
                  <span className="mx-1 h-5 w-px bg-cyan/35" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={cancelEditingContent}
                    className="inline-flex h-8 items-center justify-center rounded-md px-2.5 text-xs font-semibold text-muted-foreground transition hover:bg-white/10 hover:text-foreground active:scale-[0.96]"
                    title="取消编辑"
                  >
                    取消编辑
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
          className="content-scroll max-h-[65dvh] flex-1 space-y-1.5 overflow-auto p-2.5 text-sm leading-6 text-foreground/90 sm:max-h-[36rem]"
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
          {!isEditingContent && translationError ? (
            <div className="px-2.5 py-1 text-xs font-medium text-amber">{translationError}</div>
          ) : null}
        </div>
      </section>

      <section className="flex min-w-0 flex-col overflow-hidden rounded-md border border-cyan/20">
          <div className={cn(
            "flex min-h-[4.25rem] items-center justify-end gap-2 px-3 py-2",
            hasSummaryOutput ? "border-b border-white/10" : "",
          )}>
            <div ref={summaryMenuRef} className="flex items-center gap-1.5">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
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
                  title="选择总结提示词"
                >
                  <Sparkles className="size-3.5 transition group-hover:rotate-12 group-hover:scale-110" aria-hidden="true" />
                  总结
                  <ChevronDown className={cn("size-3 transition", summaryMenuOpen ? "rotate-180" : "")} aria-hidden="true" />
                </button>
                {summaryMenuOpen ? (
                  <SummaryPromptMenu
                    prompts={prompts}
                    onCustomPrompt={() => {
                      setSummaryMenuOpen(false);
                      setPromptDialogOpen(true);
                    }}
                    onSelect={(prompt) => void summarize(prompt)}
                  />
                ) : null}
              </div>
              {hasSummaryOutput && !isSummarizing ? (
                <button
                  type="button"
                  onClick={resetSummary}
                  className="inline-flex size-8 items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.1] active:scale-[0.94]"
                  aria-label="重新生成"
                  title="重新生成"
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>
          <div
            ref={summaryScrollRef}
            className={cn("content-scroll max-h-[65dvh] flex-1 overflow-auto sm:max-h-[36rem]", hasSummaryOutput ? "p-3" : "")}
          >
            {hasSummaryOutput ? (
              isSummarizing && !summary ? (
                <div className="flex h-full min-h-52 items-center justify-center gap-2 text-sm leading-7 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin text-cyan" />
                  <LoadingText>正在生成</LoadingText>
                </div>
              ) : (
                <div className="relative min-h-52 p-4 text-sm leading-7 text-foreground/90">
                  {summaryError ? (
                    <div className="flex h-40 items-center justify-center gap-2 text-amber">
                      <AlertCircle className="size-4" />
                      {summaryError}
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
              <LightRays className="min-h-52 sm:min-h-[36rem]" />
            )}
          </div>
        </section>

      {promptDialogOpen ? (
        <CustomPromptDialog
          onClose={() => setPromptDialogOpen(false)}
          onSave={saveCustomPrompt}
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
    { label: "转录文本", mode: "transcript" },
    { label: "字幕", mode: "subtitles" },
  ];

  return (
    <div className="inline-flex items-center gap-1 text-xs font-semibold">
      {items.map((item, index) => {
        const active = mode === item.mode;
        return (
          <Fragment key={item.mode}>
            {index > 0 ? <span className="text-muted-foreground/55">/</span> : null}
            <button
              type="button"
              onClick={() => onChange(item.mode)}
              className={cn(
                "inline-flex h-8 items-center justify-center rounded-sm px-1.5 transition active:scale-[0.98]",
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
  searchMatches,
  searchOpen,
  searchQuery,
  selectedSearchMatchIndex,
  toggleSearch,
  updateSearchQuery,
}: {
  activeSearchQuery: string;
  clearSearchQuery: () => void;
  moveSearchMatch: (direction: -1 | 1) => void;
  searchMatches: number;
  searchOpen: boolean;
  searchQuery: string;
  selectedSearchMatchIndex: number;
  toggleSearch: () => void;
  updateSearchQuery: (value: string) => void;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center overflow-hidden rounded-md transition",
        searchOpen
          ? "w-full max-w-[20rem] border border-cyan/25 bg-black/20 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)]"
          : "w-auto border border-transparent bg-transparent",
      )}
    >
      <button
        type="button"
        onClick={toggleSearch}
        className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 px-2.5 text-xs font-semibold text-cyan transition hover:bg-cyan/[0.08] active:scale-[0.96]"
        title="搜索"
      >
        <Search className="size-3.5" aria-hidden="true" />
        搜索
      </button>
      {searchOpen ? (
        <>
          <span className="h-4 w-px shrink-0 bg-white/10" aria-hidden="true" />
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">搜索原文</span>
            <input
              value={searchQuery}
              onChange={(event) => updateSearchQuery(event.target.value)}
              className="h-9 w-full bg-transparent px-2 pr-[4.75rem] text-xs text-foreground outline-none placeholder:text-muted-foreground"
              placeholder="输入关键词"
            />
            {activeSearchQuery ? (
              <span className="absolute right-8 top-1/2 inline-flex h-5 min-w-7 -translate-y-1/2 items-center justify-center rounded-sm bg-amber/[0.1] px-1.5 text-[0.68rem] font-semibold tabular-nums text-amber">
                {searchMatches > 0 ? `${selectedSearchMatchIndex + 1}/${searchMatches}` : "0"}
              </span>
            ) : null}
            {searchQuery ? (
              <button
                type="button"
                onClick={clearSearchQuery}
                className="absolute right-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-white/10 hover:text-foreground active:scale-[0.94]"
                aria-label="清除搜索"
                title="清除搜索"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </label>
          {activeSearchQuery ? (
            <div className="mr-1 flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => moveSearchMatch(-1)}
                disabled={searchMatches < 1}
                className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-cyan/[0.08] hover:text-cyan active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="上一个匹配"
                title="上一个匹配"
              >
                <ChevronUp className="size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => moveSearchMatch(1)}
                disabled={searchMatches < 1}
                className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-cyan/[0.08] hover:text-cyan active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="下一个匹配"
                title="下一个匹配"
              >
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ) : null}
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
        <div className="mt-1 text-xs text-amber">{translation.error}</div>
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
        <div className="mt-1 text-xs text-amber">{translation.error}</div>
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
  onCustomPrompt,
  onSelect,
  prompts,
}: {
  onCustomPrompt: () => void;
  onSelect: (prompt: SummaryPrompt) => void;
  prompts: SummaryPrompt[];
}) {
  return (
    <div className="mobile-popover w-auto overflow-hidden rounded-md border border-white/12 bg-[#171a27] shadow-2xl shadow-black/40 sm:w-[min(20rem,calc(100vw-2rem))]">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
        <div className="text-sm font-semibold text-foreground">提示词库</div>
        <button
          type="button"
          onClick={onCustomPrompt}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold text-cyan transition hover:bg-cyan/[0.1] active:scale-[0.94]"
          aria-label="添加自定义提示词"
          title="添加自定义提示词"
        >
          自定义提示词
          <Plus className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="content-scroll max-h-[min(28rem,calc(100dvh-9rem))] overflow-auto py-1">
        {prompts.map((prompt) => (
          <button
            key={prompt.id}
            type="button"
            onClick={() => onSelect(prompt)}
            className="block w-full px-3 py-2.5 text-left transition hover:bg-cyan/[0.07] active:bg-cyan/[0.1]"
          >
            <div className="text-sm font-semibold leading-5 text-foreground">{prompt.title}</div>
            <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
              {prompt.description}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
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
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (title: string, prompt: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const canSave = title.trim().length > 0 && prompt.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-sm sm:items-center sm:px-4 sm:py-6">
      <div className="max-h-[calc(100dvh_-_1.5rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] w-full max-w-xl overflow-auto rounded-lg border border-white/20 bg-background p-4 shadow-2xl shadow-black/40 sm:max-h-[calc(100dvh_-_3rem)]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h4 className="text-base font-semibold">添加自定义提示词</h4>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
            aria-label="关闭"
            title="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-foreground">标题</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="h-10 w-full rounded-md border border-white/15 bg-black/20 px-3 text-sm outline-none transition placeholder:text-muted-foreground focus:border-cyan focus:ring-2 focus:ring-cyan/20"
            placeholder="请输入标题。"
          />
        </label>
        <label className="mt-3 block">
          <span className="mb-2 block text-sm font-medium text-foreground">描述</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            className="h-36 w-full resize-none rounded-md border border-white/15 bg-black/20 p-3 text-sm leading-6 outline-none transition placeholder:text-muted-foreground focus:border-cyan focus:ring-2 focus:ring-cyan/20"
            placeholder="请输入描述。"
          />
        </label>
        <div className="mt-4 grid gap-2.5 sm:flex sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center rounded-md border border-white/15 px-4 text-sm font-semibold text-foreground transition hover:bg-white/10 active:scale-[0.98] sm:h-9"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(title.trim(), prompt.trim())}
            disabled={!canSave}
            className="inline-flex h-10 items-center justify-center rounded-md bg-cyan px-4 text-sm font-semibold text-black transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground sm:h-9"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function supportsTranscriptSpeakers(asrModel: string | undefined): boolean {
  return asrModel !== "qwen3-asr-flash-filetrans";
}

function supportsTranscriptSpeakerEmotion(asrModel: string | undefined): boolean {
  return asrModel === "qwen3-asr-flash-filetrans";
}

function normalizeTranscriptSegments(
  content: string,
  segments: TranscriptSegment[] | undefined,
): TranscriptSegment[] {
  const usableSegments = segments?.filter((segment) => segment.text.trim());
  const normalized = stripTrailingDouyinWatermarkFromTranscript({
    content,
    transcriptSegments: usableSegments,
  });
  if (normalized.transcriptSegments?.length) {
    return normalized.transcriptSegments;
  }

  const normalizedContent = normalized.content?.trim();
  return normalizedContent ? [{ endSeconds: 0, startSeconds: 0, text: normalizedContent }] : [];
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

function readAsrAudioHeaders(
  response: Response,
  asset: MediaAssetKind,
): Pick<CachedMediaAsset, "asrAudioObjectKey" | "asrAudioUrl"> {
  if (asset !== "originalAudio") {
    return {};
  }

  const asrAudioObjectKey = decodeResponseHeader(response, "x-echolens-asr-audio-object-key");
  const asrAudioUrl = decodeResponseHeader(response, "x-echolens-asr-audio-url");
  return asrAudioObjectKey && asrAudioUrl ? { asrAudioObjectKey, asrAudioUrl } : {};
}

function decodeResponseHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  return value ? decodeURIComponent(value) : "";
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

