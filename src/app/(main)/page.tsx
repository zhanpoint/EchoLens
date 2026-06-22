"use client";

import Image from "next/image";
import Link from "next/link";
import {
  AlertCircle,
  AudioLines,
  Captions,
  CheckCircle2,
  Check,
  Copy,
  Download,
  Eye,
  ExternalLink,
  Image as ImageIcon,
  Link2,
  Loader2,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FEATURES_BY_KIND,
  getFeatureLabel,
  type DouyinKind,
  type ExtractResponse,
  type ExtractionFeature,
  type ExtractionResult,
  type MediaAsset,
  type MediaAssetKind,
  type ResolvedDouyinWork,
  type TranscriptSegment,
} from "@/types/douyin";
import { buildMediaDownloadPath, canDownloadAsset } from "@/lib/douyin/download";
import { cn } from "@/lib/utils";

type ApiError = {
  error: string;
  code?: string;
};

type ApiPayload = ApiError | ExtractResponse | { work?: ResolvedDouyinWork };
type SummaryPayload = ApiError | { summary?: string };
type CachedMediaAsset = {
  downloadName: string;
  error?: string;
  isLoading: boolean;
  url?: string;
  workKey: string;
};

type SummaryPrompt = {
  description: string;
  id: string;
  prompt: string;
  title: string;
};

type ClipboardDouyinInput = {
  tags: string[];
  text: string;
  url: string;
};

async function readApiPayload(response: Response, fallback: string): Promise<ApiPayload> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("json")) {
    throw new Error(`${fallback}接口返回了非 JSON 响应：HTTP ${response.status}。请检查线上 /api 反向代理或服务端运行日志。`);
  }

  try {
    return JSON.parse(text) as ApiPayload;
  } catch {
    throw new Error(`${fallback}接口返回的 JSON 格式无效：HTTP ${response.status}。`);
  }
}

async function readSummaryPayload(response: Response): Promise<SummaryPayload> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error(`AI处理接口返回了非 JSON 响应：HTTP ${response.status}。`);
  }

  try {
    return JSON.parse(text) as SummaryPayload;
  } catch {
    throw new Error(`AI处理接口返回的 JSON 格式无效：HTTP ${response.status}。`);
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

  const urlText = match[0].replace(/[)\]}.,!?;，。！？；、]+$/u, "");
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
  note: "图文笔记",
  article: "文章",
};

const FEATURE_ICONS: Record<ExtractionFeature, typeof Captions> = {
  cover: ImageIcon,
  caption: Captions,
  originalTranscript: AudioLines,
  dubbedTranscript: Music2,
  imageContent: ImageIcon,
  articleText: ScrollText,
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
  { asset: "dubbedAudio", icon: Music2, label: "下载配音", previewLabel: "试听配音" },
];

const WORK_LINK_HINT = "未识别到可处理的抖音作品。请重新粘贴正确的作品分享链接，或直接粘贴作品 URL 地址。";
const URL_PATTERN = /https?:\/\/[^\s"'<>，。！？；、）】》\\]+/i;
const TAG_PATTERN = /#\s*[\p{L}\p{N}_-]+/gu;
const CLIPBOARD_INPUT_LIMIT = 5000;

const REQUIRED_ASSET_BY_FEATURE: Partial<Record<ExtractionFeature, MediaAssetKind>> = {
  cover: "cover",
  originalTranscript: "originalAudio",
  dubbedTranscript: "dubbedAudio",
};

const SUMMARY_PROMPTS: SummaryPrompt[] = [
  {
    id: "key-points",
    title: "核心要点",
    description: "适合所有人，快速抓重点、结论和风险机会。",
    prompt:
      "你是一个专业的信息提炼专家。请用最简洁、结构化的方式提取以下内容的核心要点、关键结论、重要细节、风险和机会。用中文输出，分点列出，每点不超过30字。优先保留可行动的信息，不要加入原文没有的信息。",
  },
  {
    id: "actions",
    title: "行动建议",
    description: "适合上班族和普通用户，把信息变成下一步行动。",
    prompt:
      "请阅读以下内容，提取3到5个最重要的信息点，并为每个点给出1到2句实用行动建议。输出格式为：信息点、为什么重要、建议怎么做。语言通俗直接，适合普通人马上执行。",
  },
  {
    id: "quick-read",
    title: "一分钟看懂",
    description: "适合赶时间的人，用最短时间理解原文。",
    prompt:
      "请把以下内容改写成一分钟能看完的版本，控制在150到200字。必须包含核心信息、用户最关心的结果、需要注意的风险。语言极简通俗，分段清楚，不要堆砌术语。",
  },
  {
    id: "labor-law",
    title: "劳动权益",
    description: "适合职场、合同、试用期、薪资和裁员场景。",
    prompt:
      "你是一名劳动法和职场权益顾问。请分析以下内容中公司的做法是否合理，劳动者有哪些权利，可能存在哪些坑、风险和证据点，最后给出清晰的应对步骤。用直接、务实的中文输出。不要编造法律条款，无法确定时请标注需要进一步核实。",
  },
  {
    id: "business-project",
    title: "商业机会",
    description: "适合创业者和副业人群，判断能不能做、怎么做。",
    prompt:
      "你是一个商业顾问。请提取以下内容中的商业模式、目标用户、核心机会、成本门槛、风险点和可复制的执行步骤。最后给出普通人是否适合操作的判断，并说明理由。输出要务实，避免空泛鸡汤。",
  },
  {
    id: "learning-notes",
    title: "学习笔记",
    description: "适合学生和学习者，沉淀知识点、技巧和记忆点。",
    prompt:
      "你是一个高效学习教练。请从以下内容中提取最有价值的知识点、实用技巧、常见误区和记忆要点。以学完能立刻用为目标组织输出，并给出一个简短的复习清单。",
  },
  {
    id: "decision",
    title: "决策辅助",
    description: "适合选择困难、买不买、做不做、选哪个。",
    prompt:
      "你是一个理性决策助手。请分析以下内容中的利弊、优缺点、隐藏风险、必要前提和不确定信息。最后给出清晰推荐：建议做、谨慎做或不建议做，并说明理由和适用人群。",
  },
  {
    id: "short-video-script",
    title: "短视频脚本",
    description: "适合自媒体创作者，把内容改成可发布脚本。",
    prompt:
      "请把以下内容转化为适合抖音或短视频的高吸引力脚本。输出包括：钩子开头、核心卖点、正文结构、情绪推进、结尾呼吁行动。语气生动接地气，适合口播，不要偏离原文事实。",
  },
  {
    id: "titles-quotes",
    title: "标题金句",
    description: "适合运营和创作者，快速产出标题、金句和卖点。",
    prompt:
      "请从以下内容中提取5条短而有力的金句、3个有传播感的标题、3个适合评论区或封面使用的短句。标题要有明确情绪或数字，但不能标题党，必须符合原文信息。",
  },
  {
    id: "deep-dive",
    title: "深度拆解",
    description: "适合研究、复盘和复杂内容，发现逻辑与意图。",
    prompt:
      "请对以下内容做深度拆解，包含：核心论点、隐含假设、逻辑漏洞、未说明的关键信息、作者可能的真实意图、我应该如何应对。请同时从普通用户、专业人士、老板或决策者三个视角给出不同关注点。",
  },
];

export default function HomePage() {
  const [input, setInput] = useState("");
  const [work, setWork] = useState<ResolvedDouyinWork | null>(null);
  const [selected, setSelected] = useState<ExtractionFeature[]>([]);
  const [results, setResults] = useState<ExtractionResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasAcceptedUsage, setHasAcceptedUsage] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [lastResolvedInput, setLastResolvedInput] = useState("");
  const isReadingClipboardRef = useRef(false);
  const cachedAssets = useWorkAssetCache(work);

  const normalizedInput = input.trim();
  const isInputDirty = Boolean(work && normalizedInput !== lastResolvedInput);
  const activeKind = hasAcceptedUsage && work && !isInputDirty ? work.kind : null;
  const displayWork = activeKind ? work : null;
  const availableFeatures = useMemo(
    () => displayWork ? getAvailableFeatures(displayWork, cachedAssets) : [],
    [cachedAssets, displayWork],
  );
  const selectedFeatures = useMemo(
    () => availableFeatures.filter((feature) => selected.includes(feature)),
    [availableFeatures, selected],
  );
  const cacheBlockMessage = useMemo(
    () => displayWork ? getExtractionCacheBlockMessage(selectedFeatures, cachedAssets, displayWork) : null,
    [cachedAssets, displayWork, selectedFeatures],
  );
  const visibleResults = useMemo(
    () => results.filter((result) => availableFeatures.includes(result.feature)),
    [availableFeatures, results],
  );
  const canExtract = Boolean(
    hasAcceptedUsage &&
    work &&
    !isInputDirty &&
    selectedFeatures.length > 0 &&
    !isExtracting &&
    !cacheBlockMessage,
  );

  const resolveInput = useCallback(async (value: string, options?: { showLinkHint?: boolean; silent?: boolean }) => {
    const valueToResolve = value.trim();
    if (!valueToResolve) {
      setError("请输入抖音分享链接。");
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

      if (!response.ok || !("work" in payload) || !payload.work) {
        throw new Error("error" in payload ? payload.error : "识别链接失败。");
      }

      setLastResolvedInput(valueToResolve);
      setWork(payload.work);
      setSelected(FEATURES_BY_KIND[payload.work.kind]);
      setResults([]);
      setError(null);
    } catch (resolveError) {
      setWork(null);
      setSelected([]);
      setResults([]);
      if (!options?.silent) {
        setError(resolveError instanceof Error ? resolveError.message : "识别链接失败。");
      } else if (options.showLinkHint) {
        setError(WORK_LINK_HINT);
      }
    } finally {
      setIsResolving(false);
    }
  }, []);

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
        setWork(null);
        setSelected([]);
        setResults([]);
        setLastResolvedInput("");
        setError(null);
        setInput(clipboard.text);
      }
    }

    function retryFromClipboard() {
      void fillFromClipboard();
    }

    window.addEventListener("focus", retryFromClipboard);
    window.addEventListener("pointerdown", retryFromClipboard, { capture: true });
    window.addEventListener("keydown", retryFromClipboard, { capture: true });
    window.addEventListener("paste", retryFromClipboard, { capture: true });
    document.addEventListener("visibilitychange", retryFromClipboard);

    return () => {
      isActive = false;
      window.removeEventListener("focus", retryFromClipboard);
      window.removeEventListener("pointerdown", retryFromClipboard, { capture: true });
      window.removeEventListener("keydown", retryFromClipboard, { capture: true });
      window.removeEventListener("paste", retryFromClipboard, { capture: true });
      document.removeEventListener("visibilitychange", retryFromClipboard);
    };
  }, [input]);

  useEffect(() => {
    const hasUrl = /https?:\/\//i.test(normalizedInput);
    if (!hasAcceptedUsage) {
      return;
    }

    if (!normalizedInput) {
      return;
    }

    if (normalizedInput === lastResolvedInput) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (!hasUrl) {
        setWork(null);
        setSelected([]);
        setResults([]);
        setError(WORK_LINK_HINT);
        return;
      }

      void resolveInput(normalizedInput, { showLinkHint: true, silent: true });
    }, 700);

    return () => window.clearTimeout(timer);
  }, [hasAcceptedUsage, lastResolvedInput, normalizedInput, resolveInput]);

  async function extract() {
    if (!canExtract || !work || isInputDirty) {
      return;
    }

    if (cacheBlockMessage) {
      setError(cacheBlockMessage);
      return;
    }

    setIsExtracting(true);
    setError(null);
    setResults([]);

    try {
      const response = await fetch("/api/douyin/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: normalizedInput, features: selectedFeatures }),
      });
      const payload = await readApiPayload(response, "提取失败。");

      if (!response.ok || !("results" in payload)) {
        throw new Error("error" in payload ? payload.error : "提取失败。");
      }

      setLastResolvedInput(normalizedInput);
      setWork(payload.work);
      setResults(orderResults(payload.results, selectedFeatures));
    } catch (extractError) {
      setError(extractError instanceof Error ? extractError.message : "提取失败。");
    } finally {
      setIsExtracting(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasAcceptedUsage) {
      setError("请先确认仅用于个人学习和非商业用途，并尊重原作者版权。");
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

  function updateInput(value: string) {
    setInput(value);
    if (!value.trim()) {
      setError(null);
    }
  }

  function clearInput() {
    setInput("");
    setWork(null);
    setSelected([]);
    setResults([]);
    setLastResolvedInput("");
    setError(null);
  }

  function toggleFeature(feature: ExtractionFeature) {
    setSelected((current) =>
      current.includes(feature)
        ? current.filter((item) => item !== feature)
        : availableFeatures.filter((item) => item === feature || current.includes(item)),
    );
  }

  return (
    <main className="app-shell min-h-[100dvh] overflow-x-hidden bg-background text-foreground">
      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-5 sm:py-7 md:gap-7 md:py-10">
        <div className="flex items-center justify-center gap-3">
          <Image
            src="/echolens-logo.svg"
            alt=""
            width={50}
            height={45}
            className="h-12 w-[3.375rem] shrink-0 object-contain"
          />
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-foreground">EchoLens</h1>
            <p className="text-sm text-muted-foreground">透视抖音作品的声音与文字</p>
          </div>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="order-1 flex cursor-pointer items-start gap-3 rounded-md border border-white/15 bg-black/20 px-3 py-3 text-left transition hover:border-cyan/35 sm:px-4 md:order-2">
            <input
              type="checkbox"
              checked={hasAcceptedUsage}
              onChange={(event) => updateUsageConsent(event.target.checked)}
              className="mt-0.5 size-5 shrink-0 accent-cyan sm:size-4"
            />
            <span className="text-sm leading-6 text-muted-foreground">
              我确认仅用于个人学习和非商业用途，并尊重原作者版权；已阅读并同意
              <Link
                href="/legal"
                className="mx-1 font-semibold text-cyan underline decoration-cyan/50 underline-offset-4 transition hover:text-amber hover:decoration-amber"
              >
                法律声明
              </Link>
              。
            </span>
          </label>

          <div className="order-2 flex flex-col gap-3 md:order-1 md:flex-row md:items-center">
            <div
              className={cn(
                "flex min-h-14 flex-1 items-center gap-3 rounded-md border bg-black/20 px-4 transition",
                hasAcceptedUsage
                  ? "border-cyan/35 focus-within:border-cyan/80 focus-within:ring-2 focus-within:ring-cyan/20"
                  : "border-white/10 opacity-65",
              )}
            >
              <Link2 className={cn("size-5 shrink-0", hasAcceptedUsage ? "text-amber" : "text-muted-foreground")} />
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
            <div className="mb-4 border-b border-white/10 pb-4">
              <dl className="grid items-start gap-x-5 gap-y-4 text-left text-sm md:grid-cols-[10rem_14rem_minmax(0,1fr)]">
                <InfoRow label="作品类型" value={KIND_LABELS[activeKind]} />
                <InfoRow
                  label="作者"
                  value={displayWork?.authorName ?? "未识别"}
                  href={displayWork?.authorUrl}
                />
                <InfoRow
                  label="作品链接"
                  value={displayWork?.finalUrl ?? "未识别"}
                  href={displayWork?.finalUrl}
                  compact
                />
              </dl>
              {displayWork ? <WorkDownloadActions cachedAssets={cachedAssets} work={displayWork} /> : null}
            </div>
          ) : null}

          <div
            className={cn(
              "grid gap-3",
              activeKind ? "md:grid-cols-4" : "md:grid-cols-3",
            )}
          >
            {activeKind ? (
              availableFeatures.map((feature) => (
                <FeatureToggle
                  key={feature}
                  feature={feature}
                  label={`提取${getFeatureLabel(feature, activeKind)}`}
                  checked={selected.includes(feature)}
                  onToggle={() => toggleFeature(feature)}
                />
              ))
            ) : (
              <div className="relative z-10 flex min-h-36 flex-col items-center justify-center gap-2 p-6 text-center md:col-span-3">
                <div className="text-base font-semibold text-foreground">
                  {isResolving ? "正在识别作品" : "等待作品链接"}
                </div>
                <p className="max-w-md text-sm leading-6 text-muted-foreground">
                  {isResolving ? "正在匹配可提取的内容模块。" : "粘贴链接后，EchoLens 会自动展开可提取的内容模块。"}
                </p>
              </div>
            )}
          </div>

          {error ? (
            <div className="mt-5 flex items-center justify-center gap-2 px-4 py-2 text-center text-sm text-destructive">
              <AlertCircle className="size-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {!error && cacheBlockMessage ? (
            <div className="mt-5 flex items-center justify-center gap-2 px-4 py-2 text-center text-sm text-cyan">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <span>{cacheBlockMessage}</span>
            </div>
          ) : null}

          {activeKind ? (
            <div className="mt-5 flex justify-center border-t border-white/10 pt-5">
              <button
                type="button"
                onClick={() => void extract()}
                disabled={!canExtract}
                className={cn(
                  "inline-flex h-11 w-full items-center justify-center gap-2 rounded-md px-7 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed sm:w-auto",
                  canExtract
                    ? "bg-amber text-black shadow-lg shadow-amber/20 hover:brightness-110"
                    : "border border-white/10 bg-muted text-muted-foreground shadow-none",
                )}
              >
                <span className="inline-flex items-center gap-2">
                  {isExtracting ? <Loader2 className="size-4 animate-spin" /> : null}
                  开始提取
                </span>
              </button>
            </div>
          ) : null}
        </section>

        <section
          className={cn(
            "rounded-lg border border-white/25 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.07)]",
            visibleResults.length > 0 ? "p-4 sm:p-5" : "overflow-hidden p-0",
          )}
        >
          {visibleResults.length > 0 ? (
            <div className="grid gap-5">
              {visibleResults.map((result) => (
                <ResultBlock key={result.feature} result={result} />
              ))}
            </div>
          ) : (
            <EmptyResults isExtracting={isExtracting} />
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
      <span className="hidden text-white/20 sm:inline" aria-hidden="true">/</span>
      <Link className="rounded-sm px-1.5 py-1 transition hover:text-cyan" href="/legal#copyright">版权合规</Link>
      <span className="hidden text-white/20 sm:inline" aria-hidden="true">/</span>
      <Link className="rounded-sm px-1.5 py-1 transition hover:text-cyan" href="/legal#usage">使用限制</Link>
    </footer>
  );
}

function EmptyResults({ isExtracting }: { isExtracting: boolean }) {
  return (
    <div className="empty-result-stage min-h-56">
      <div className="empty-result-signal" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="empty-result-copy text-center" aria-live="polite">
        <div className="text-sm font-semibold text-foreground">
          {isExtracting ? "正在生成结果" : "等待提取"}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {isExtracting ? "正在整理可复制的文本内容。" : "提取后的内容会在这里展开"}
        </p>
      </div>
    </div>
  );
}

function getAvailableFeatures(
  work: ResolvedDouyinWork,
  cachedAssets: Partial<Record<MediaAssetKind, CachedMediaAsset>>,
): ExtractionFeature[] {
  return FEATURES_BY_KIND[work.kind].filter((feature) => {
    const asset = REQUIRED_ASSET_BY_FEATURE[feature];
    if (!asset || !canDownloadAsset(work.kind, asset)) {
      return true;
    }

    return !isDownloadResourceUnavailable(getCachedAsset(cachedAssets, work, asset));
  });
}

function getExtractionCacheBlockMessage(
  features: ExtractionFeature[],
  cachedAssets: Partial<Record<MediaAssetKind, CachedMediaAsset>>,
  work: ResolvedDouyinWork,
): string | null {
  for (const feature of features) {
    const asset = REQUIRED_ASSET_BY_FEATURE[feature];
    if (!asset || !canDownloadAsset(work.kind, asset)) {
      continue;
    }

    const cached = getCachedAsset(cachedAssets, work, asset);
    if (!cached || cached.isLoading) {
      return `正在缓存${getFeatureLabel(feature, work.kind)}所需资源，请等待缓存完成后再提取。`;
    }
    if (!cached.url) {
      return cached.error ?? `${getFeatureLabel(feature, work.kind)}所需资源缓存失败，请取消该项或稍后重试。`;
    }
  }

  return null;
}

function getCachedAsset(
  cachedAssets: Partial<Record<MediaAssetKind, CachedMediaAsset>>,
  work: ResolvedDouyinWork,
  asset: MediaAssetKind,
): CachedMediaAsset | undefined {
  const cached = cachedAssets[asset];
  return cached?.workKey === `${work.kind}:${work.id}` ? cached : undefined;
}

function isDownloadResourceUnavailable(cached: CachedMediaAsset | undefined): boolean {
  return Boolean(
    cached &&
      !cached.isLoading &&
      !cached.url &&
      cached.error?.includes("没有采集到可下载资源"),
  );
}

function FeatureToggle({
  feature,
  label,
  checked,
  onToggle,
}: {
  feature: ExtractionFeature;
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const Icon = FEATURE_ICONS[feature];

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "group relative flex min-h-16 items-center justify-between gap-3 overflow-hidden rounded-md border p-3 text-left text-sm transition active:scale-[0.99] sm:min-h-20 sm:gap-4 sm:p-4",
        checked
          ? "border-cyan/55 bg-cyan/[0.055] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255_/_0.05)]"
          : "border-white/10 bg-white/[0.02] hover:border-amber/35 hover:bg-amber/[0.035]",
      )}
      aria-pressed={checked}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-3 left-0 w-0.5 rounded-full transition",
          checked ? "bg-cyan" : "bg-transparent group-hover:bg-amber/70",
        )}
      />
      <div className="flex min-w-0 gap-3">
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md border transition",
            checked ? "border-cyan/35 bg-cyan/10" : "border-white/10 bg-black/15 group-hover:border-amber/25",
          )}
        >
          <Icon className={cn("size-4", checked ? "text-cyan" : "text-muted-foreground group-hover:text-amber")} />
        </div>
        <div className="min-w-0">
          <div className="font-medium">{label}</div>
        </div>
      </div>
      <span
        className={cn(
          "relative mt-1 h-5 w-9 shrink-0 rounded-full border transition",
          checked ? "border-cyan bg-cyan shadow-cyan/20" : "border-white/15 bg-muted",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-white transition",
            checked ? "left-4" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}

function InfoRow({
  label,
  value,
  compact,
  href,
}: {
  label: string;
  value: string;
  compact?: boolean;
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
    <div className="min-w-0 text-left">
      <dt className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("flex min-h-7 min-w-0 items-center gap-1.5 text-left font-semibold text-foreground", compact && "text-xs")}>
        <span className="min-w-0 flex-1">
          {isLinked ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center justify-start gap-1.5 text-cyan underline decoration-cyan/50 underline-offset-4 transition hover:text-amber hover:decoration-amber"
            >
              <span className={cn("min-w-0", compact ? "break-all" : "truncate")}>{value}</span>
              <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
            </a>
          ) : (
            value
          )}
        </span>
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
      </dd>
    </div>
  );
}

function useWorkAssetCache(work: ResolvedDouyinWork | null): Partial<Record<MediaAssetKind, CachedMediaAsset>> {
  const [cachedAssets, setCachedAssets] = useState<Partial<Record<MediaAssetKind, CachedMediaAsset>>>({});
  const objectUrlsRef = useRef<string[]>([]);
  const workId = work?.id ?? "";
  const workKind = work?.kind;
  const workKey = workKind && workId ? `${workKind}:${workId}` : "";
  const cacheWork = useMemo(() => workKind && workId ? { id: workId, kind: workKind } : null, [workId, workKind]);
  const actions = useMemo(
    () => cacheWork ? DOWNLOAD_ACTIONS.filter((action) => canDownloadAsset(cacheWork.kind, action.asset)) : [],
    [cacheWork],
  );

  useEffect(() => {
    if (!cacheWork) {
      return;
    }

    const controller = new AbortController();
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

    for (const action of actions) {
      void cacheAsset(cacheWork, workKey, action.asset, controller.signal)
        .then((cached) => {
          if (!cached.url) {
            return;
          }
          if (controller.signal.aborted) {
            URL.revokeObjectURL(cached.url);
            return;
          }
          objectUrls.push(cached.url);
          setCachedAssets((current) => ({
            ...current,
            [action.asset]: cached,
          }));
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }
          setCachedAssets((current) => ({
            ...current,
            [action.asset]: {
              downloadName: buildCachedAssetFilename(cacheWork, action.asset),
              error: error instanceof Error ? error.message : "资源缓存失败。",
              isLoading: false,
              workKey,
            },
          }));
        });
    }

    return () => {
      controller.abort();
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current = [];
    };
  }, [actions, cacheWork, workKey]);

  return cachedAssets;
}

function WorkDownloadActions({
  cachedAssets,
  work,
}: {
  cachedAssets: Partial<Record<MediaAssetKind, CachedMediaAsset>>;
  work: ResolvedDouyinWork;
}) {
  const workKey = `${work.kind}:${work.id}`;
  const actions = useMemo(
    () => DOWNLOAD_ACTIONS.filter((action) => canDownloadAsset(work.kind, action.asset)),
    [work.kind],
  );
  const [preview, setPreview] = useState<(typeof actions)[number] | null>(null);

  const previewCache = preview ? cachedAssets[preview.asset] : undefined;
  const previewCached = previewCache?.workKey === workKey ? previewCache : undefined;

  return (
    <>
      <div className="mt-4 grid gap-2 pb-1 sm:grid-cols-2 md:flex md:flex-wrap md:items-center md:gap-3">
        {actions.map((action) => {
          const href = buildMediaDownloadPath(work, action.asset);
          const assetLabel = action.label.replace("下载", "");
          const maybeCached = cachedAssets[action.asset];
          const cached = maybeCached?.workKey === workKey ? maybeCached : undefined;
          const assetUrl = cached?.url ?? href;
          const isCaching = !cached || cached.isLoading;
          const hasCacheError = Boolean(cached?.error && !cached.url);
          const cacheTitle = cached?.error ?? (isCaching ? "正在缓存到本地" : action.previewLabel);

          return (
            <div
              key={action.asset}
              className="flex h-12 w-full min-w-0 items-center gap-2 rounded-md border border-cyan/20 bg-cyan/[0.035] px-2.5 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)] md:w-auto md:flex-none"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-cyan/20 bg-black/20 text-cyan">
                  <action.icon className="size-4" aria-hidden="true" />
                </span>
                <span className="truncate text-sm font-semibold text-foreground">{assetLabel}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPreview(action)}
                  disabled={isCaching || hasCacheError}
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-md border border-white/10 text-muted-foreground transition hover:border-cyan/30 hover:bg-cyan/[0.08] hover:text-cyan active:scale-[0.96] disabled:opacity-50",
                    isCaching ? "disabled:cursor-wait" : "disabled:cursor-not-allowed",
                  )}
                  aria-label={action.previewLabel}
                  title={cacheTitle}
                >
                  {isCaching ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : hasCacheError ? (
                    <AlertCircle className="size-4" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                </button>
                {hasCacheError ? (
                  <button
                    type="button"
                    disabled
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-white/10 px-3 text-sm font-semibold text-muted-foreground opacity-60"
                    title={cached?.error}
                  >
                    <Download className="size-4" aria-hidden="true" />
                    下载
                  </button>
                ) : (
                  <a
                    href={assetUrl}
                    download={cached?.url ? cached.downloadName : undefined}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-cyan px-3 text-sm font-semibold text-black transition hover:brightness-110 active:scale-[0.96]"
                    title={isCaching ? "正在缓存到本地，当前会使用服务端下载" : action.label}
                  >
                    <Download className="size-4" aria-hidden="true" />
                    下载
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {preview ? (
        <AssetPreviewDialog
          action={preview}
          previewUrl={previewCached?.url ?? buildMediaDownloadPath(work, preview.asset, { preview: true })}
          downloadName={previewCached?.downloadName}
          downloadUrl={previewCached?.url ?? buildMediaDownloadPath(work, preview.asset)}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  );
}

async function cacheAsset(
  work: Pick<ResolvedDouyinWork, "id" | "kind">,
  workKey: string,
  asset: MediaAssetKind,
  signal: AbortSignal,
): Promise<CachedMediaAsset> {
  const response = await fetch(buildMediaDownloadPath(work, asset), {
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new Error(await readCacheAssetError(response));
  }

  const blob = await response.blob();
  return {
    downloadName: buildCachedAssetFilename(work, asset, blob.type),
    isLoading: false,
    url: URL.createObjectURL(blob),
    workKey,
  };
}

async function readCacheAssetError(response: Response): Promise<string> {
  const fallback = `资源缓存失败：HTTP ${response.status}。`;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return fallback;
  }

  try {
    const payload = await response.json() as Partial<ApiError>;
    return payload.error ? `资源缓存失败：${payload.error}` : fallback;
  } catch {
    return fallback;
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
    return asset === "dubbedAudio" ? "m4a" : "mp4";
  }

  return asset === "cover" ? "jpg" : asset === "originalAudio" ? "wav" : asset === "dubbedAudio" ? "m4a" : "mp4";
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
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-sm sm:items-center sm:px-4 sm:py-6">
      <div className="max-h-[calc(100dvh-1.5rem)] w-full max-w-3xl overflow-hidden rounded-lg border border-white/20 bg-background shadow-2xl shadow-black/40 sm:max-h-[calc(100dvh-3rem)]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 font-semibold">
            <action.icon className="size-4 shrink-0 text-cyan" aria-hidden="true" />
            <span className="truncate">{action.previewLabel}</span>
          </div>
          <div className="flex items-center gap-1">
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
        <div className="max-h-[calc(100dvh-5.5rem)] overflow-auto bg-black/25 p-3 sm:p-4">
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
            资源加载中
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
            视频加载中
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

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (audio.paused) {
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

  return (
    <div className="relative rounded-md border border-cyan/15 bg-[linear-gradient(180deg,rgb(255_255_255_/_0.045),rgb(255_255_255_/_0.018))] p-3 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)] sm:p-4">
      {error || !loaded ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-black/45 backdrop-blur-[2px]">
          <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
            {error ? <AlertCircle className="size-4 text-amber" /> : <Loader2 className="size-4 animate-spin text-cyan" />}
            {error ?? "音频加载中"}
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
        <Volume2 className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
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
  orderedFeatures: ExtractionFeature[],
): ExtractionResult[] {
  return [...results].sort(
    (first, second) =>
      orderedFeatures.indexOf(first.feature) - orderedFeatures.indexOf(second.feature),
  );
}

function ResultBlock({ result }: { result: ExtractionResult }) {
  const ok = result.status === "success";

  return (
    <article>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {ok ? <CheckCircle2 className="size-4 shrink-0 text-cyan" /> : <AlertCircle className="size-4 shrink-0 text-amber" />}
          <h3 className="truncate font-medium">{result.label}</h3>
        </div>
      </div>
      {result.content ? (
        isTranscriptFeature(result.feature) ? (
          <TranscriptResultPanel result={result} />
        ) : (
          <TextResultPanel label={result.label} text={result.content} />
        )
      ) : result.assets?.length ? (
        <MediaAssetPanel assets={result.assets} />
      ) : (
        <p className="flex min-h-24 items-center justify-center px-4 py-8 text-center text-sm text-muted-foreground">
          {result.detail ?? "没有返回内容。"}
        </p>
      )}
    </article>
  );
}

function TextResultPanel({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);

  async function copyContent() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void copyContent()}
        className="absolute right-2 top-2 z-10 inline-flex size-8 items-center justify-center rounded-md bg-background/80 text-muted-foreground backdrop-blur transition hover:bg-amber/[0.12] hover:text-amber active:scale-[0.94]"
        aria-label={copied ? "已复制" : `复制${label}`}
        title={copied ? "已复制" : "复制"}
      >
        {copied ? <Check className="size-4 text-cyan" /> : <Copy className="size-4" />}
      </button>
      <div className="content-canvas content-scroll max-h-[65dvh] overflow-auto rounded-md border border-white/[0.16] bg-background/70 py-3 pl-3 pr-11 text-sm leading-7 text-foreground/90 sm:max-h-[36rem] sm:py-4 sm:pl-4 sm:pr-12">
        <ContentText text={text} />
      </div>
    </div>
  );
}

function TranscriptResultPanel({ result }: { result: ExtractionResult }) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [summaryMode, setSummaryMode] = useState(false);
  const [summary, setSummary] = useState("");
  const [summaryError, setSummaryError] = useState("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [customPrompts, setCustomPrompts] = useState<SummaryPrompt[]>([]);
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const segments = normalizeTranscriptSegments(result.content ?? "", result.transcriptSegments);
  const prompts = [...SUMMARY_PROMPTS, ...customPrompts];
  const hasSummaryOutput = isSummarizing || Boolean(summary || summaryError);

  async function copyAll() {
    await navigator.clipboard.writeText(result.content ?? "");
    setCopiedAll(true);
    window.setTimeout(() => setCopiedAll(false), 1600);
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
    setSummaryMode(true);
    setSummary("");
    setSummaryError("");
    setIsSummarizing(true);

    try {
      const response = await fetch("/api/douyin/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: prompt.prompt, text: result.content }),
      });
      const payload = await readSummaryPayload(response);
      if (!response.ok || !("summary" in payload) || !payload.summary) {
        throw new Error("error" in payload ? payload.error : "AI处理失败。");
      }
      setSummary(payload.summary);
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : "AI处理失败。");
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

  return (
    <div className={cn("grid gap-3", summaryMode ? "lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.85fr)]" : "grid-cols-1")}>
      <section className="flex min-w-0 flex-col overflow-hidden rounded-md border border-white/[0.16] bg-background/70">
        <div className="flex min-h-[4.25rem] flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">原文</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSummaryMode((value) => !value)}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-cyan/25 bg-cyan/[0.08] px-2.5 text-xs font-semibold text-cyan transition hover:border-cyan/45 hover:bg-cyan/[0.12] active:scale-[0.96]"
              title={summaryMode ? "收起AI面板" : "AI处理"}
            >
              <Sparkles className="size-3.5" aria-hidden="true" />
              AI处理
            </button>
            <button
              type="button"
              onClick={() => void copyAll()}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-amber/[0.12] hover:text-amber active:scale-[0.94]"
              aria-label={copiedAll ? `已复制${result.label}` : `复制${result.label}`}
              title={copiedAll ? "已复制" : "复制全文"}
            >
              {copiedAll ? <Check className="size-4 text-cyan" /> : <Copy className="size-4" />}
            </button>
          </div>
        </div>
        <div className="content-scroll max-h-[65dvh] flex-1 space-y-3 overflow-auto p-3 text-sm leading-7 text-foreground/90 sm:max-h-[36rem]">
          {segments.map((segment, index) => (
            <TranscriptSegmentCard
              key={`${segment.startSeconds}-${index}`}
              segment={segment}
            />
          ))}
        </div>
      </section>

      {summaryMode ? (
        <section className="flex min-w-0 flex-col overflow-hidden rounded-md border border-cyan/20 bg-[linear-gradient(180deg,rgb(6_182_212_/_0.06),rgb(255_255_255_/_0.018))]">
          <div className="flex min-h-[4.25rem] items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-cyan">
              <Sparkles className="size-3.5" aria-hidden="true" />
              AI处理
            </span>
            <div className="flex items-center gap-1.5">
              {hasSummaryOutput && !isSummarizing && !summaryError ? (
                <button
                  type="button"
                  onClick={() => void copySummary()}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-amber/[0.12] hover:text-amber active:scale-[0.94]"
                  aria-label={copiedSummary ? "已复制AI结果" : "复制AI结果"}
                  title={copiedSummary ? "已复制" : "复制结果"}
                >
                  {copiedSummary ? <Check className="size-4 text-cyan" /> : <Copy className="size-4" />}
                </button>
              ) : null}
              {hasSummaryOutput && !isSummarizing ? (
                <button
                  type="button"
                  onClick={resetSummary}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-cyan/25 px-2.5 text-xs font-semibold text-cyan transition hover:bg-cyan/[0.08] active:scale-[0.96]"
                >
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  重新生成
                </button>
              ) : null}
            </div>
          </div>
          <div className="content-scroll max-h-[65dvh] flex-1 overflow-auto p-3 sm:max-h-[36rem]">
            {hasSummaryOutput ? (
              isSummarizing ? (
                <div className="flex h-full min-h-52 items-center justify-center gap-2 text-sm leading-7 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin text-cyan" />
                  正在生成
                </div>
              ) : (
                <div className="min-h-52 rounded-md border border-white/[0.14] bg-black/20 p-4 text-sm leading-7 text-foreground/90">
                  {summaryError ? (
                    <div className="flex h-40 items-center justify-center gap-2 text-amber">
                      <AlertCircle className="size-4" />
                      {summaryError}
                    </div>
                  ) : (
                    <MarkdownPreview text={summary} />
                  )}
                </div>
              )
            ) : (
              <div className="space-y-2.5">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  {prompts.map((prompt) => (
                    <button
                      key={prompt.id}
                      type="button"
                      onClick={() => void summarize(prompt)}
                      className="min-h-[4.25rem] rounded-md border border-white/10 bg-black/15 px-3 py-2 text-left transition hover:border-cyan/35 hover:bg-cyan/[0.055] active:scale-[0.99]"
                    >
                      <div className="text-sm font-semibold leading-5 text-foreground">{prompt.title}</div>
                      <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {prompt.description}
                      </div>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setPromptDialogOpen(true)}
                  className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-dashed border-cyan/30 bg-cyan/[0.045] px-3 text-sm font-semibold text-cyan transition hover:border-cyan/55 hover:bg-cyan/[0.08] active:scale-[0.98]"
                >
                  <Plus className="size-4" aria-hidden="true" />
                  添加自定义提示词
                </button>
              </div>
            )}
          </div>
        </section>
      ) : null}

      {promptDialogOpen ? (
        <CustomPromptDialog
          onClose={() => setPromptDialogOpen(false)}
          onSave={saveCustomPrompt}
        />
      ) : null}
    </div>
  );
}

function MarkdownPreview({ text }: { text: string }) {
  const lines = text.split("\n");
  const nodes: ReactNode[] = [];
  let listItems: string[] = [];
  let listKey = 0;
  let tableKey = 0;

  function flushList() {
    if (!listItems.length) {
      return;
    }

    nodes.push(
      <ul key={`list-${listKey}`} className="my-3 list-disc space-y-1 pl-5 text-foreground/90">
        {listItems.map((item, index) => (
          <li key={`${listKey}-${index}`}>
            <MarkdownInline text={item} />
          </li>
        ))}
      </ul>,
    );
    listKey += 1;
    listItems = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const table = readMarkdownTable(lines, index);
    if (table) {
      flushList();
      nodes.push(
        <div key={`table-${tableKey}`} className="my-4 overflow-x-auto rounded-md border border-white/10">
          <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
            <thead className="bg-cyan/[0.08] text-cyan">
              <tr>
                {table.headers.map((header, headerIndex) => (
                  <th
                    key={`head-${headerIndex}`}
                    className="border-b border-white/10 px-3 py-2 font-semibold"
                  >
                    <MarkdownInline text={header} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {table.rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`} className="align-top odd:bg-white/[0.025]">
                  {row.map((cell, cellIndex) => (
                    <td key={`cell-${rowIndex}-${cellIndex}`} className="px-3 py-2 leading-6 text-foreground/90">
                      <MarkdownInline text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      tableKey += 1;
      index = table.endIndex;
      continue;
    }

    const trimmed = line.trim();
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/u);
    const listItem = trimmed.match(/^[-*]\s+(.+)$/u);
    const orderedListItem = trimmed.match(/^\d+[.)]\s+(.+)$/u);

    if (!trimmed) {
      flushList();
      nodes.push(<div key={`blank-${index}`} className="h-2" />);
      continue;
    }

    if (listItem || orderedListItem) {
      listItems.push((listItem?.[1] ?? orderedListItem?.[1] ?? "").trim());
      continue;
    }

    flushList();

    if (heading) {
      const level = heading[1].length;
      nodes.push(
        <div
          key={`${index}-${trimmed}`}
          className={cn(
            "mt-4 first:mt-0 font-semibold text-foreground",
            level === 1 && "text-base",
            level === 2 && "text-sm",
            level === 3 && "text-sm text-cyan",
          )}
        >
          <MarkdownInline text={heading[2]} />
        </div>,
      );
      continue;
    }

    nodes.push(
      <p key={`${index}-${trimmed.slice(0, 12)}`} className="my-2 whitespace-pre-wrap break-words text-foreground/90">
        <MarkdownInline text={trimmed} />
      </p>,
    );
  }

  flushList();

  return <div className="break-words">{nodes}</div>;
}

function readMarkdownTable(
  lines: string[],
  startIndex: number,
): { endIndex: number; headers: string[]; rows: string[][] } | null {
  const header = splitMarkdownTableRow(lines[startIndex]);
  const separator = splitMarkdownTableRow(lines[startIndex + 1] ?? "");
  if (!header || !separator || header.length < 2 || !isMarkdownTableSeparator(separator)) {
    return null;
  }

  const rows: string[][] = [];
  let endIndex = startIndex + 1;
  for (let index = startIndex + 2; index < lines.length; index += 1) {
    const row = splitMarkdownTableRow(lines[index]);
    if (!row) {
      break;
    }

    rows.push(normalizeMarkdownTableRow(row, header.length));
    endIndex = index;
  }

  return {
    endIndex,
    headers: normalizeMarkdownTableRow(header, header.length),
    rows,
  };
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return null;
  }

  return trimmed
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function normalizeMarkdownTableRow(cells: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => cells[index] ?? "");
}

function MarkdownInline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/gu);

  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={`${index}-${part.slice(0, 8)}`} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }

    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={`${index}-${part.slice(0, 8)}`}
          className="rounded-sm border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-cyan"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    return <span key={`${index}-${part.slice(0, 8)}`}>{part}</span>;
  });
}

function TranscriptSegmentCard({ segment }: { segment: TranscriptSegment }) {
  const [copied, setCopied] = useState(false);

  async function copySegment() {
    await navigator.clipboard.writeText(segment.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="group relative rounded-md border border-transparent p-3 transition hover:border-cyan/20 hover:bg-cyan/[0.045]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-cyan">
          {formatSegmentTime(segment.startSeconds)}
        </span>
        <button
          type="button"
          onClick={() => void copySegment()}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-amber/[0.12] hover:text-amber group-hover:opacity-100 focus:opacity-100 active:scale-[0.94]"
          aria-label={copied ? "已复制该时间段" : "复制该时间段"}
          title={copied ? "已复制" : "复制该时间段"}
        >
          {copied ? <Check className="size-4 text-cyan" /> : <Copy className="size-4" />}
        </button>
      </div>
      <div className="whitespace-pre-wrap break-words text-foreground/90">
        <TaggedText text={segment.text} />
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
      <div className="max-h-[calc(100dvh-1.5rem)] w-full max-w-xl overflow-auto rounded-lg border border-white/20 bg-background p-4 shadow-2xl shadow-black/40 sm:max-h-[calc(100dvh-3rem)]">
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

function isTranscriptFeature(feature: ExtractionFeature): boolean {
  return feature === "originalTranscript" || feature === "dubbedTranscript";
}

function normalizeTranscriptSegments(
  content: string,
  segments: TranscriptSegment[] | undefined,
): TranscriptSegment[] {
  const usableSegments = segments?.filter((segment) => segment.text.trim());
  if (usableSegments?.length) {
    return usableSegments;
  }

  return [{ endSeconds: 0, startSeconds: 0, text: content }];
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

function MediaAssetPanel({ assets }: { assets: MediaAsset[] }) {
  const coverAsset = assets.find((asset) => asset.kind === "cover");

  if (coverAsset) {
    return <CoverAssetPanel asset={coverAsset} />;
  }

  return (
    <div className="rounded-md border border-white/[0.16] bg-background/70 p-4">
      <div className="flex flex-wrap gap-2">
        {assets.map((asset) => (
          <a
            key={`${asset.kind}-${asset.url}`}
            href={asset.url}
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-1 text-sm font-semibold text-cyan transition hover:bg-cyan/[0.08] hover:text-amber active:scale-[0.98]"
          >
            <Download className="size-4" aria-hidden="true" />
            {asset.label}
          </a>
        ))}
      </div>
    </div>
  );
}

function CoverAssetPanel({ asset }: { asset: MediaAsset }) {
  const [copied, setCopied] = useState(false);
  const imageUrl = asset.previewUrl ?? asset.url;

  async function copyCover() {
    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      if (blob.type.startsWith("image/") && "ClipboardItem" in window) {
        await navigator.clipboard.write([
          new ClipboardItem({
            [blob.type]: blob,
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(new URL(asset.url, window.location.origin).toString());
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      await navigator.clipboard.writeText(new URL(asset.url, window.location.origin).toString());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }

  return (
    <div className="w-full max-w-[34rem] overflow-hidden rounded-md border border-white/[0.16] bg-background/70 p-3">
      <div className="relative overflow-hidden rounded-md bg-black/20">
        <Image
          src={imageUrl}
          alt="封面预览"
          width={900}
          height={506}
          unoptimized
          className="h-auto w-full object-cover"
        />
        <div className="absolute right-2 top-2 flex gap-1.5">
          <a
            href={asset.url}
            className="inline-flex size-8 items-center justify-center rounded-md bg-black/45 text-white/85 backdrop-blur transition hover:bg-cyan/20 hover:text-cyan active:scale-[0.94]"
            aria-label="下载封面"
            title="下载封面"
          >
            <Download className="size-4" aria-hidden="true" />
          </a>
          <button
            type="button"
            onClick={() => void copyCover()}
            className="inline-flex size-8 items-center justify-center rounded-md bg-black/45 text-white/85 backdrop-blur transition hover:bg-amber/20 hover:text-amber active:scale-[0.94]"
            aria-label={copied ? "已复制封面" : "复制封面"}
            title={copied ? "已复制" : "复制封面"}
          >
            {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function ContentText({ text }: { text: string }) {
  return (
    <div className="break-words">
      {text.split("\n").map((line, index) => {
        const imageLabel = line.trim().match(/^第\s*(\d+)\s*张图片$/u);

        if (imageLabel) {
          return (
            <div
              key={`${index}-${line}`}
              className="mb-2 mt-5 inline-flex rounded-sm bg-cyan/10 px-2 py-1 text-xs font-semibold text-cyan ring-1 ring-cyan/20 first:mt-0"
            >
              第{imageLabel[1]}张图片
            </div>
          );
        }

        return line ? (
          <div key={`${index}-${line.slice(0, 8)}`} className="whitespace-pre-wrap">
            <TaggedText text={line} />
          </div>
        ) : (
          <div key={`blank-${index}`} className="h-4" />
        );
      })}
    </div>
  );
}

function TaggedText({ text }: { text: string }) {
  const parts = text.split(/(#[\p{L}\p{N}_-]+)/gu);

  return parts.map((part, index) =>
    part.startsWith("#") ? (
      <span
        key={`${part}-${index}`}
        className="mx-0.5 inline-flex rounded-sm border border-[#9bb892]/20 bg-[#9bb892]/10 px-1.5 py-0.5 text-[#adc4a3]"
      >
        {part}
      </span>
    ) : (
      <span key={`${index}-${part.slice(0, 8)}`}>{part}</span>
    ),
  );
}
