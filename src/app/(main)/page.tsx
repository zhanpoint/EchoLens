"use client";

import Image from "next/image";
import {
  AlertCircle,
  AudioLines,
  Captions,
  CheckCircle2,
  Check,
  Copy,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Link2,
  Loader2,
  Music2,
  Play,
  ScrollText,
} from "lucide-react";
import {
  type FormEvent,
  useEffect,
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
} from "@/types/douyin";
import { buildMediaDownloadPath, canDownloadAsset } from "@/lib/douyin/download";
import { cn } from "@/lib/utils";

type ApiError = {
  error: string;
  code?: string;
};

const KIND_LABELS: Record<DouyinKind, string> = {
  video: "视频",
  note: "图文笔记",
  article: "文章",
};

const FEATURE_ICONS: Record<ExtractionFeature, typeof Captions> = {
  cover: ImageIcon,
  caption: Captions,
  transcript: AudioLines,
  imageContent: ImageIcon,
  articleText: ScrollText,
};

const DOWNLOAD_ACTIONS: Array<{
  asset: MediaAssetKind;
  icon: typeof Download;
  label: string;
}> = [
  { asset: "cover", icon: ImageIcon, label: "下载封面" },
  { asset: "video", icon: Play, label: "下载视频" },
  { asset: "audio", icon: Music2, label: "下载配音" },
];

export default function HomePage() {
  const [input, setInput] = useState("");
  const [work, setWork] = useState<ResolvedDouyinWork | null>(null);
  const [selected, setSelected] = useState<ExtractionFeature[]>([]);
  const [results, setResults] = useState<ExtractionResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [lastResolvedInput, setLastResolvedInput] = useState("");

  const normalizedInput = input.trim();
  const isInputDirty = Boolean(work && normalizedInput !== lastResolvedInput);
  const activeKind = work && !isInputDirty ? work.kind : null;
  const availableFeatures = activeKind ? FEATURES_BY_KIND[activeKind] : [];
  const canExtract = Boolean(work && !isInputDirty && selected.length > 0 && !isExtracting);
  const displayWork = activeKind ? work : null;

  useEffect(() => {
    const hasUrl = /https?:\/\//i.test(normalizedInput);
    if (!hasUrl || normalizedInput === lastResolvedInput) {
      return;
    }

    const timer = window.setTimeout(() => {
      void resolveInput(normalizedInput, { silent: true });
    }, 700);

    return () => window.clearTimeout(timer);
  }, [lastResolvedInput, normalizedInput]);

  async function resolveInput(value: string, options?: { silent?: boolean }) {
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
      const payload = (await response.json()) as { work?: ResolvedDouyinWork } | ApiError;

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
      }
    } finally {
      setIsResolving(false);
    }
  }

  async function extract() {
    if (!canExtract) {
      return;
    }

    const orderedFeatures = availableFeatures.filter((feature) => selected.includes(feature));
    setIsExtracting(true);
    setError(null);
    setResults([]);

    try {
      const response = await fetch("/api/douyin/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: normalizedInput, features: orderedFeatures }),
      });
      const payload = (await response.json()) as ExtractResponse | ApiError;

      if (!response.ok || !("results" in payload)) {
        throw new Error("error" in payload ? payload.error : "提取失败。");
      }

      setLastResolvedInput(normalizedInput);
      setWork(payload.work);
      setResults(orderResults(payload.results, orderedFeatures));
    } catch (extractError) {
      setError(extractError instanceof Error ? extractError.message : "提取失败。");
    } finally {
      setIsExtracting(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void resolveInput(normalizedInput);
  }

  function toggleFeature(feature: ExtractionFeature) {
    setSelected((current) =>
      current.includes(feature)
        ? current.filter((item) => item !== feature)
        : availableFeatures.filter((item) => item === feature || current.includes(item)),
    );
  }

  return (
    <main className="app-shell min-h-screen overflow-hidden bg-background text-foreground">
      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-col gap-7 px-5 py-8 md:py-10">
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
            <p className="text-sm text-muted-foreground">透视视频内容的声音与文字</p>
          </div>
        </div>

        <form onSubmit={submit}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="flex min-h-14 flex-1 items-center gap-3 rounded-md border border-cyan/35 bg-black/20 px-4 transition focus-within:border-cyan/80 focus-within:ring-2 focus-within:ring-cyan/20">
              <Link2 className="size-5 shrink-0 text-amber" />
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                placeholder="粘贴抖音作品的分享链接或者地址。"
              />
            </div>
            <button
              type="submit"
              disabled={isResolving || !normalizedInput}
              className="inline-flex h-12 items-center justify-center rounded-md bg-cyan px-4 text-sm font-semibold text-black shadow-lg shadow-cyan/20 transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
            >
              {isResolving ? "检测中" : "智能检测"}
            </button>
          </div>
        </form>

        <section
          className={cn(
            "relative overflow-hidden rounded-lg border p-5",
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
              {displayWork ? <WorkDownloadActions work={displayWork} /> : null}
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-3">
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
              <div className="relative z-10 flex min-h-36 flex-col items-center justify-center gap-2 p-6 text-center md:col-span-2">
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
            results.length > 0 ? "p-5" : "overflow-hidden p-0",
          )}
        >
          {results.length > 0 ? (
            <div className="grid gap-5">
              {results.map((result) => (
                <ResultBlock key={result.feature} result={result} />
              ))}
            </div>
          ) : (
            <EmptyResults isExtracting={isExtracting} />
          )}
        </section>
      </div>
    </main>
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
        "group relative flex min-h-20 items-center justify-between gap-4 overflow-hidden rounded-md border p-4 text-left transition active:scale-[0.99]",
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

  return (
    <div className="min-w-0 text-left">
      <dt className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("min-h-7 text-left font-semibold text-foreground", compact && "text-xs")}>
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
      </dd>
    </div>
  );
}

function WorkDownloadActions({ work }: { work: ResolvedDouyinWork }) {
  const actions = DOWNLOAD_ACTIONS.filter((action) => canDownloadAsset(work.kind, action.asset));

  return (
    <div className="mt-4 flex flex-nowrap items-center gap-5 overflow-x-auto whitespace-nowrap pb-1">
      {actions.map((action) => (
        <DownloadLink
          key={action.asset}
          href={buildMediaDownloadPath(work, action.asset)}
          icon={action.icon}
          label={action.label}
        />
      ))}
    </div>
  );
}

function DownloadLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: typeof Download;
  label: string;
}) {
  return (
    <a
      href={href}
      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-1 text-sm font-semibold text-cyan transition hover:bg-cyan/[0.08] hover:text-amber active:scale-[0.98]"
    >
      <Icon className="size-4" aria-hidden="true" />
      {label}
    </a>
  );
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
  const [copied, setCopied] = useState(false);

  async function copyContent() {
    if (!result.content) {
      return;
    }

    await navigator.clipboard.writeText(result.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <article>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {ok ? <CheckCircle2 className="size-4 shrink-0 text-cyan" /> : <AlertCircle className="size-4 shrink-0 text-amber" />}
          <h3 className="truncate font-medium">{result.label}</h3>
        </div>
      </div>
      {result.content ? (
        <div className="relative">
          <button
            type="button"
            onClick={() => void copyContent()}
            className="absolute right-2 top-2 z-10 inline-flex size-8 items-center justify-center rounded-md bg-background/80 text-muted-foreground backdrop-blur transition hover:bg-amber/[0.12] hover:text-amber active:scale-[0.94]"
            aria-label={copied ? "已复制" : `复制${result.label}`}
            title={copied ? "已复制" : "复制"}
          >
            {copied ? <Check className="size-4 text-cyan" /> : <Copy className="size-4" />}
          </button>
          <div className="content-canvas content-scroll max-h-[36rem] overflow-auto rounded-md border border-white/[0.16] bg-background/70 py-4 pl-4 pr-12 text-sm leading-7 text-foreground/90">
            <ContentText text={result.content} />
          </div>
        </div>
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

function MediaAssetPanel({ assets }: { assets: MediaAsset[] }) {
  const coverAsset = assets.find((asset) => asset.kind === "cover");

  if (coverAsset) {
    return <CoverAssetPanel asset={coverAsset} />;
  }

  return (
    <div className="rounded-md border border-white/[0.16] bg-background/70 p-4">
      <div className="flex flex-wrap gap-2">
        {assets.map((asset) => (
          <DownloadLink
            key={`${asset.kind}-${asset.url}`}
            href={asset.url}
            icon={Download}
            label={asset.label}
          />
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
