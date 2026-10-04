"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowLeft,
  ArrowRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  History,
  Info,
  Layers3,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Video,
  X,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { requestCurrentUser } from "@/app/douyin/_client-api";
import {
  readClientSessionCache,
  writeClientSessionCache,
} from "@/lib/transcript/client-session-cache";
import type {
  AuthorVideo,
  AuthorVideoPage,
  BatchDetail,
  BatchJob,
  BatchPlatform,
  ExportFormat,
} from "@/lib/batch/contracts";
import { videoUrl } from "@/lib/batch/contracts";
import { DEFAULT_FILTER_DRAFT, draftFromFilters, normalizeSearchText, normalizeTags, parseFilterDraft, selectAuthorVideos, type AuthorVideoFilters } from "@/lib/batch/video-filters";
import { supportsDownloadDirectoryPicker } from "@/lib/browser-download-directory";
import { saveBatchFiles } from "@/lib/batch/browser-export";
import { VideoFilterFields } from "./video-filter-fields";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Catalogue = {
  platform: BatchPlatform;
  input: string;
  authorId: string;
  authorName: string;
  videos: AuthorVideo[];
  cursor: string | null;
  total?: number;
};
const button =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring";
const actionButton = cn(button, "h-8 px-2.5 text-xs");
const CACHE_KEY = "batch-author-catalogue-v2";
const FILTER_CACHE_KEY = "batch-author-filters-v1";
type FilterCache = Pick<Catalogue, "platform" | "input"> & { filters: AuthorVideoFilters };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败，请稍后重试。");
  return payload as T;
}

export function BatchPage() {
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [cacheRestored, setCacheRestored] = useState(false);
  const [platform, setPlatform] = useState<BatchPlatform>("douyin");
  const [input, setInput] = useState("");
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [filterDraft, setFilterDraft] = useState(DEFAULT_FILTER_DRAFT);
  const parsedFilters = useMemo(() => parseFilterDraft(filterDraft), [filterDraft]);
  const [page, setPage] = useState(0);
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(false);
  const scanController = useRef<AbortController | null>(null);
  const [scanState, setScanState] = useState<
    "idle" | "interrupted" | "complete" | "error"
  >("idle");
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [activeId, setActiveId] = useState("");
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [offset, setOffset] = useState(0);
  const [exportMode, setExportMode] = useState("merged");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("md");
  const canSaveDirectory = Boolean(userId) && supportsDownloadDirectoryPicker();
  const [exporting, setExporting] = useState(false);
  const [exportCount, setExportCount] = useState(0);
  const exportController = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState<
    "submit" | "pause" | "resume" | "retry" | "cancel" | null
  >(null);
  const [retryItemId, setRetryItemId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const refreshRevision = useRef(0);
  const hasRunningJobs = useRef(false);

  useEffect(() => {
    mounted.current = true;
    void requestCurrentUser()
      .then(async (user) => {
        if (!mounted.current) return;
        setUserId(user.id);
        const [cache, filterCache] = await Promise.all([
          readClientSessionCache<Catalogue>(user.id, CACHE_KEY).catch(() => null),
          readClientSessionCache<FilterCache>(user.id, FILTER_CACHE_KEY).catch(() => null),
        ]);
        if (mounted.current) {
          const source = cache ?? filterCache;
          if (source) {
            setPlatform(source.platform);
            setInput(source.input);
            if (filterCache?.platform === source.platform && filterCache.input === source.input)
              setFilterDraft(draftFromFilters(filterCache.filters));
          }
          if (cache) {
            setCatalogue(cache);
            setScanState(cache.cursor !== null ? "interrupted" : "complete");
          }
        }
        if (mounted.current) setCacheRestored(true);
      })
      .catch((failure) => {
        if (failure.message === "UNAUTHENTICATED")
          router.replace("/login?next=%2Fbatch");
        else setError(failure.message);
      });
    return () => {
      mounted.current = false;
      scanController.current?.abort();
      exportController.current?.abort();
    };
  }, [router]);

  useEffect(() => {
    if (!userId || !cacheRestored || !parsedFilters.success || !input.trim()) return;
    const timer = setTimeout(() => {
      void writeClientSessionCache<FilterCache>(userId, FILTER_CACHE_KEY, {
        platform, input: input.trim(), filters: parsedFilters.data,
      }).catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [userId, cacheRestored, platform, input, parsedFilters]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const revision = ++refreshRevision.current;
    const result = await api<{ jobs: BatchJob[] }>("/api/batch");
    if (!mounted.current || revision !== refreshRevision.current) return;
    setJobs(result.jobs);
    hasRunningJobs.current = result.jobs.some(
      (entry) => entry.status === "running",
    );
    const id = activeId || result.jobs[0]?.id;
    if (id) {
      if (!activeId) setActiveId(id);
      const batch = await api<BatchDetail>(`/api/batch/${id}?offset=${offset}`);
      if (mounted.current && revision === refreshRevision.current)
        setDetail(batch);
    }
  }, [userId, activeId, offset]);

  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await refresh();
      } catch (failure) {
        if (!canceled)
          setError(
            failure instanceof Error ? failure.message : "任务状态读取失败。",
          );
      }
      if (!canceled)
        timer = setTimeout(
          () => void poll(),
          document.hidden || !hasRunningJobs.current ? 15_000 : 3000,
        );
    }
    void poll();
    return () => {
      canceled = true;
      refreshRevision.current += 1;
      clearTimeout(timer);
    };
  }, [refresh]);

  async function scan(restart: boolean) {
    if (!userId || scanningRef.current) return;
    scanningRef.current = true;
    const controller = new AbortController();
    scanController.current = controller;
    setScanning(true);
    setScanState("idle");
    setError("");
    let current =
      !restart &&
      catalogue?.platform === platform &&
      catalogue.input === input.trim()
        ? catalogue
        : null;
    const byId = new Map(current?.videos.map(video => [video.id, video]));
    if (restart) {
      setCatalogue(null);
      setSelected(new Set());
      setPage(0);
      setSearch("");
    }
    const visited = new Set<string>();
    try {
      do {
        const cursor = current?.cursor ?? (platform === "douyin" ? "0" : "1");
        if (visited.has(cursor))
          throw new Error(
            "分页游标重复，已停止获取。已获取的视频已保存，可稍后继续。",
          );
        visited.add(cursor);
        const result = await api<AuthorVideoPage>("/api/batch/author-videos", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            platform,
            input: current?.authorId || input.trim(),
            ...(current?.cursor ? { cursor: current.cursor } : {}),
          }),
        });
        for (const video of result.videos) byId.set(video.id, video);
        current = {
          platform,
          input: input.trim(),
          authorId: result.authorId,
          authorName: result.authorName || current?.authorName || "",
          videos: [...byId.values()],
          cursor: result.cursor,
          total: result.total ?? current?.total,
        };
        if (!mounted.current) return;
        setCatalogue(current);
        await writeClientSessionCache(userId, CACHE_KEY, current).catch(
          () => undefined,
        );
      } while (current.cursor !== null && !controller.signal.aborted);
      if (mounted.current)
        setScanState(current.cursor === null ? "complete" : "interrupted");
    } catch (failure) {
      if (mounted.current) {
        setScanState(controller.signal.aborted ? "interrupted" : "error");
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : "获取作品失败。",
          );
      }
    } finally {
      scanningRef.current = false;
      scanController.current = null;
      if (mounted.current) setScanning(false);
    }
  }

  const matchingCatalogue =
    catalogue?.platform === platform && catalogue.input === input.trim() ? catalogue : null;
  const scopedVideos = useMemo(
    () => matchingCatalogue && parsedFilters.success
      ? selectAuthorVideos(matchingCatalogue.videos, parsedFilters.data)
      : [],
    [matchingCatalogue, parsedFilters],
  );
  const videos = useMemo(
    () =>
      scopedVideos.filter((video) =>
        normalizeSearchText(video.title).includes(normalizeSearchText(search)),
      ),
    [scopedVideos, search],
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(videos.length / 30) - 1));
  const visible = videos.slice(currentPage * 30, currentPage * 30 + 30);
  const rankingPending = Boolean(matchingCatalogue && matchingCatalogue.cursor !== null &&
    parsedFilters.success && parsedFilters.data.limit);
  const chosen = useMemo(() => {
    const byId = new Map(
      scopedVideos.map((video) => [video.id, video]),
    );
    return [...selected].flatMap((id) => {
      const video = byId.get(id);
      return video ? [video] : [];
    });
  }, [scopedVideos, selected]);
  const allSelected =
    videos.length > 0 && videos.every((video) => selected.has(video.id));
  const job = detail?.job;
  const percent = job?.total
    ? Math.round(
        ((job.succeeded + (job.skipped || 0) + job.failed + (job.canceled || 0)) / job.total) * 100,
      )
    : 0;

  async function submit() {
    setBusy("submit");
    setError("");
    try {
      const result = await api<{ id: string }>("/api/batch", {
        method: "POST",
        body: JSON.stringify({
          platform,
          authorName: matchingCatalogue?.authorName,
          model: "e1",
          videos: chosen,
        }),
      });
      setActiveId(result.id);
      setOffset(0);
      setSelected(new Set());
      refreshRevision.current += 1;
      setDetail(await api<BatchDetail>(`/api/batch/${result.id}`));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "创建任务失败。");
    } finally {
      setBusy(null);
    }
  }

  async function control(action: "pause" | "resume" | "retry" | "cancel", itemId?: string) {
    if (!job) return;
    setBusy(action);
    setRetryItemId(itemId ?? null);
    refreshRevision.current += 1;
    setError("");
    try {
      await api(`/api/batch/${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action, ...(itemId ? { itemId } : {}) }),
      });
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "任务操作失败。");
    } finally {
      setBusy(null);
      setRetryItemId(null);
    }
  }

  async function exportFiles() {
    if (!job || exporting) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExportCount(0);
    setError("");
    try {
      await saveBatchFiles(job.id, exportFormat, controller.signal, (count) => {
        if (mounted.current) setExportCount(count);
      });
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && !(failure instanceof DOMException && failure.name === "AbortError"))
        setError(failure instanceof Error ? failure.message : "文件导出失败。");
    } finally {
      exportController.current = null;
      if (mounted.current) setExporting(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className={`${button} size-9 px-0`}
              aria-label="返回 EchoLens"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <div>
              <h1 className="flex items-center gap-2 text-lg font-semibold">
                <Layers3 className="size-5 text-primary" />
                博主语料采集
              </h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                收集一个作者的作品，把想留下的内容转成文字。
              </p>
            </div>
          </div>
          <Link
            href="/settings"
            className="text-sm text-muted-foreground hover:text-primary"
          >
            凭据与模型设置
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6">
        {error && (
          <div
            role="alert"
            className="mb-5 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"
          >
            {error}
          </div>
        )}
        {!userId && !error && (
          <p
            role="status"
            className="mb-5 flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            正在读取登录状态…
          </p>
        )}
          <section
            aria-labelledby="source-heading"
            className="min-w-0 rounded-lg border border-border bg-surface"
          >
            <div className="border-b border-border p-4">
              <h2 id="source-heading" className="text-sm font-semibold">
                获取用户作品
              </h2>
              <div
                className="my-4 flex gap-2"
                role="group"
                aria-label="视频平台"
              >
                {(["douyin", "bilibili"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    disabled={scanning}
                    aria-pressed={platform === value}
                    onClick={() => {
                      setPlatform(value);
                      setSelected(new Set());
                      setPage(0);
                      setScanState("idle");
                    }}
                    className={`${button} ${platform === value ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}`}
                  >
                    {value === "douyin" ? "抖音" : "哔哩哔哩"}
                  </button>
                ))}
              </div>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void scan(true);
                }}
              >
                <label htmlFor="author-link" className="sr-only">
                  用户主页链接
                </label>
                <input
                  id="author-link"
                  value={input}
                  disabled={scanning}
                  onChange={(event) => {
                    setInput(event.target.value);
                    setSelected(new Set());
                    setScanState("idle");
                  }}
                  placeholder={
                    platform === "douyin"
                      ? "粘贴抖音用户主页链接或 sec_uid"
                      : "粘贴 UP 主空间链接或 UID"
                  }
                  className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button
                  className={`${button} h-10`}
                  disabled={!userId || !input.trim() || scanning}
                >
                  {scanning ? (
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Search className="size-4" />
                  )}
                  获取
                </button>
              </form>
              <VideoFilterFields value={filterDraft} onChange={(value) => {
                setFilterDraft(value);
                setSelected(new Set());
                setPage(0);
              }} />
              {!parsedFilters.success && <p role="alert" className="mt-2 text-xs text-destructive">{parsedFilters.error.issues[0]?.message}</p>}
            </div>
            <section
              className="border-b border-border p-4"
              aria-labelledby="task-heading"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <h2 id="task-heading" className="text-sm font-semibold">任务进度</h2>
                  <Popover.Root>
                    <Popover.Trigger asChild>
                      <button type="button" aria-label="任务进度说明" className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"><Info className="size-3.5" aria-hidden="true" /></button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content align="start" sideOffset={6} className="z-50 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-surface-strong p-3 shadow-xl shadow-black/30 focus-visible:outline-2 focus-visible:outline-ring">
                        <ul className="list-disc space-y-1.5 pl-4 text-xs leading-5 text-muted-foreground">
                          <li>进度自动保存。</li>
                          <li>关闭页面后继续处理，服务重启后恢复。</li>
                          <li>暂停保留当前处理。</li>
                          <li>无语音、音频不可用或提交结果不明确时跳过当前视频。</li>
                          <li>取消终止未完成项。</li>
                        </ul>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                </div>
                <div className="flex items-center gap-2">
                  {job && job.succeeded + (job.skipped || 0) < job.total && (
                    <button
                      type="button"
                      className={cn(actionButton, "border-primary/30 text-primary hover:bg-primary/10")}
                      disabled={Boolean(busy)}
                      title="重试失败项并继续未完成项，保留已完成结果和转录检查点"
                      onClick={() => void control("retry")}
                    >
                      {busy === "retry" && !retryItemId ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="size-3.5" />}
                      {busy === "retry" && !retryItemId ? "重试中…" : "重试"}
                    </button>
                  )}
              {jobs.length > 1 && (
                <Select
                  value={activeId}
                  disabled={Boolean(busy) || exporting}
                  onValueChange={(id) => {
                    setActiveId(id);
                    setOffset(0);
                    setDetail(null);
                  }}
                >
                  <SelectTrigger
                    aria-label="选择批量任务"
                    className="h-8 w-auto gap-2 border-0 bg-transparent px-1 text-xs text-muted-foreground"
                  >
                    <History className="size-3.5" aria-hidden="true" />
                    历史任务
                  </SelectTrigger>
                  <SelectContent>
                    {jobs.map((entry, index) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        任务 {jobs.length - index} · {entry.authorName ||
                          (entry.platform === "douyin"
                            ? "抖音"
                            : "Bilibili")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
                </div>
              </div>
              {job ? (
                <>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold tabular-nums">
                      {job.succeeded + (job.skipped || 0)}
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        / {job.total} 已处理
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {job.status === "canceled"
                        ? "已取消"
                        : job.status === "paused"
                          ? "已暂停"
                          : job.status === "completed"
                            ? "已结束"
                            : "进行中"}
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label="语料采集进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    className="mb-2 h-1.5 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <p className="mb-3 text-xs leading-5 text-muted-foreground">
                    {job.succeeded} 个完成 · {job.processing} 个处理中 · {job.failed} 个失败 ·{" "}
                    {Math.max(
                      0,
                      job.total -
                        job.succeeded -
                        (job.skipped || 0) -
                        job.failed -
                        job.processing -
                        (job.interrupted || 0) -
                        (job.canceled || 0),
                    )}{" "}
                    个等待
                    {job.interrupted > 0
                      ? ` · ${job.interrupted} 个中断待恢复`
                      : ""}
                    {job.canceled > 0 ? ` · ${job.canceled} 个已取消` : ""}
                    {job.skipped > 0 ? ` · ${job.skipped} 个已跳过` : ""}
                  </p>
                  <div className="mb-3 flex flex-wrap gap-2">
                    {job.status === "running" ? (
                      <button
                        type="button"
                        className={actionButton}
                        disabled={Boolean(busy)}
                        onClick={() => void control("pause")}
                      >
                        {busy === "pause" ? (
                          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                        ) : (
                          <Pause className="size-3.5" />
                        )}
                        {busy === "pause" ? "暂停中…" : "暂停"}
                      </button>
                    ) : job.status === "paused" ? (
                      <button
                        type="button"
                        className={actionButton}
                        disabled={Boolean(busy)}
                        onClick={() => void control("resume")}
                      >
                        {busy === "resume" ? (
                          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                        ) : (
                          <Play className="size-3.5" />
                        )}
                        {busy === "resume" ? "恢复中…" : "继续"}
                      </button>
                    ) : null}
                    {(job.status === "running" || job.status === "paused") && (
                      <button
                        type="button"
                        className={`${actionButton} text-muted-foreground hover:text-destructive`}
                        disabled={Boolean(busy)}
                        onClick={() => void control("cancel")}
                      >
                        {busy === "cancel" ? (
                          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                        ) : (
                          <X className="size-3.5" />
                        )}
                        {busy === "cancel" ? "取消中…" : "取消转录"}
                      </button>
                    )}
                  </div>
                  {job.status === "paused" && (
                    <p
                      role="status"
                      className="mb-3 text-xs leading-5 text-muted-foreground"
                    >
                      已暂停派发，当前视频继续保存；点击继续可恢复等待项。
                    </p>
                  )}
                  {job.status === "canceled" && (
                    <p
                      role="status"
                      className="mb-3 text-xs leading-5 text-muted-foreground"
                    >
                      任务已取消，已完成结果仍可导出；点击重试可恢复未完成项。已提交的服务商任务可能继续执行并计费。
                    </p>
                  )}
                  <ul className="max-h-60 divide-y divide-border overflow-auto">
                    {detail.items.map((item) => (
                      <li key={item.id} className="py-2 text-xs first:pt-0 last:pb-0">
                        <div className="flex items-start gap-2">
                          {item.interrupted ? (
                            <Pause className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                          ) : item.status === "processing" || item.status === "waiting" ? (
                            <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
                          ) : (
                            <span
                              className={`mt-1 size-2 shrink-0 rounded-full ${item.status === "succeeded" ? "bg-primary" : item.status === "failed" ? "bg-destructive" : "bg-muted-foreground/30"}`}
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-foreground">
                              {item.video.title}
                            </p>
                            <p
                              className={`mt-1 leading-4 ${item.error && item.status !== "skipped" ? "text-destructive" : "text-muted-foreground"}`}
                            >
                              {item.error ? `${item.stage} · ${item.error}` : item.stage}
                            </p>
                          </div>
                          {item.status === "failed" && <button type="button" aria-label={`重试 ${item.video.title}`} title="重试此作品" disabled={Boolean(busy)} onClick={() => void control("retry", item.id)} className={cn(actionButton, "h-7 shrink-0 px-2 text-primary")}>
                            {retryItemId === item.id ? <Loader2 className="size-3 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="size-3" />}
                            {retryItemId === item.id ? "重试中…" : "重试"}
                          </button>}
                          {item.status === "succeeded" && <a href={`/api/batch/${job.id}/export?format=${exportFormat}&position=${item.position}`} aria-label={`下载 ${item.video.title}`} title="下载此作品文件" className="shrink-0 rounded p-1 text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"><Download className="size-3.5" /></a>}
                        </div>
                      </li>
                    ))}
                  </ul>
                  {job.total > 50 && (
                    <Pagination
                      page={Math.floor(offset / 50)}
                      total={job.total}
                      size={50}
                      onPage={(page) => setOffset(page * 50)}
                    />
                  )}
                </>
              ) : (
                <p className="text-xs leading-5 text-muted-foreground">
                  {activeId ? "正在加载任务…" : "选择视频并点击转录后，在这里查看进度"}
                </p>
              )}
            </section>
            <div className="p-4">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">
                    {matchingCatalogue?.authorName || "作品列表"}
                  </h3>
                  <p
                    className="mt-1 text-xs text-muted-foreground"
                    aria-live="polite"
                  >
                    已获取 {matchingCatalogue?.videos.length || 0} 个视频
                    {matchingCatalogue ? ` · 显示 ${videos.length} 个` : ""}
                    {matchingCatalogue?.total !== undefined
                      ? ` / ${matchingCatalogue.total} 个投稿`
                      : ""}{" "}
                    · 已选 {chosen.length} 个
                    {matchingCatalogue?.cursor === null ? " · 全部获取完成" : ""}
                  </p>
                </div>
                {scanning ? (
                  <button
                    type="button"
                    className={button}
                    onClick={() => {
                      scanController.current?.abort();
                    }}
                  >
                    停止获取
                  </button>
                ) : (
                  matchingCatalogue?.cursor && (
                    <button
                      type="button"
                      className={button}
                      onClick={() => void scan(false)}
                    >
                      <RefreshCw className="size-3.5" />
                      继续获取
                    </button>
                  )
                )}
              </div>
              {(scanning ||
                scanState === "interrupted" ||
                scanState === "error") && (
                <div
                  role="status"
                  className="mb-4 flex items-center gap-2 rounded-md bg-primary/5 px-3 py-2 text-xs text-muted-foreground"
                >
                  {scanning ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
                  ) : (
                    <Pause className="size-3.5 shrink-0" />
                  )}
                  {scanning
                    ? "正在获取作品，已获取的内容会逐页保存…"
                    : "获取已中断，已获取的作品已保留，可继续获取。"}
                </div>
              )}
              {rankingPending && <p role="status" className="mb-3 text-xs leading-5 text-muted-foreground">最新／最早作品的排序暂未完成，获取全部分页后可选择转录。</p>}
              <div role="group" aria-label="作品列表操作" className="mb-3 flex flex-wrap items-center gap-2">
                <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={
                      !allSelected &&
                      videos.some((video) => selected.has(video.id))
                    }
                    disabled={!videos.length || rankingPending}
                    onChange={() =>
                      setSelected((previous) => {
                        const next = new Set(previous);
                        videos.forEach((video) =>
                          allSelected
                            ? next.delete(video.id)
                            : next.add(video.id),
                        );
                        return next;
                      })
                    }
                  />
                  全选{search ? "筛选结果" : ""}
                </label>
                <input
                  aria-label="搜索作品标题"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(0);
                  }}
                  placeholder="搜索作品标题"
                  className="h-8 min-w-0 flex-1 basis-40 rounded-md border border-input bg-background px-3 text-xs focus-visible:outline-2 focus-visible:outline-ring"
                />
              <button
                type="button"
                disabled={
                  Boolean(busy) || exporting || rankingPending || chosen.length === 0 || chosen.length > 5000
                }
                onClick={() => void submit()}
                className={cn(actionButton, "shrink-0 border-primary bg-primary text-primary-foreground hover:bg-primary/90")}
              >
                {busy === "submit" ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Play className="size-4" />
                )}
                转录所选 {chosen.length} 个视频
              </button>
                <Select value={exportFormat} disabled={exporting} onValueChange={(format: ExportFormat) => setExportFormat(format)}>
                  <SelectTrigger aria-label="文件格式" className="h-8 w-28 justify-between border-input bg-background text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="md">Markdown</SelectItem><SelectItem value="txt">纯文本</SelectItem><SelectItem value="json">JSON</SelectItem></SelectContent>
                </Select>
                <Select value={exportMode} disabled={exporting} onValueChange={setExportMode}>
                  <SelectTrigger aria-label="导出方式" className="h-8 w-36 justify-between border-input bg-background text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="merged">合并为一个文件</SelectItem>
                    <SelectItem value="separate" disabled={!canSaveDirectory}>每个视频一个文件{!canSaveDirectory && "（需目录支持）"}</SelectItem>
                  </SelectContent>
                </Select>
              {job?.succeeded && exportMode === "separate" ? (
                  <button type="button" disabled={exporting || !canSaveDirectory} onClick={() => void exportFiles()} className={`${actionButton} shrink-0`}>
                    {exporting ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Download className="size-3.5" />}
                    {exporting ? `已保存 ${exportCount} 个文件` : `保存文件 (${job.succeeded})`}
                  </button>
              ) : job?.succeeded ? (
                <a
                  href={`/api/batch/${job.id}/export?format=${exportFormat}`}
                  className={`${actionButton} shrink-0`}
                >
                  <Download className="size-3.5" />
                  导出文件
                </a>
              ) : (
                <button type="button" disabled className={`${actionButton} shrink-0`}>
                  <Download className="size-3.5" />
                  暂无可导出的结果
                </button>
              )}
              </div>
              {exporting ? <button type="button" className="mb-3 rounded text-xs text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-ring" onClick={() => exportController.current?.abort()}>停止导出，保留已保存文件</button> : exportMode === "separate" && exportCount > 0 ? <p role="status" className="mb-3 text-xs text-muted-foreground">已保存 {exportCount} 个文件，可再次导出覆盖同名文件。</p> : null}
               <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto">
                {visible.map((video) => {
                  const title = displayVideoTitle(video);
                  return (
                  <li key={video.id} className="flex items-center gap-3 py-3">
                    <Checkbox
                      aria-label={`选择 ${title}`}
                      checked={selected.has(video.id)}
                      disabled={rankingPending}
                      onChange={() =>
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (next.has(video.id)) next.delete(video.id);
                          else next.add(video.id);
                          return next;
                        })
                      }
                    />
                    <div className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                      {video.coverUrl ? (
                        <Image
                          unoptimized
                          width={80}
                          height={48}
                          src={video.coverUrl}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <Video className="size-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <a
                        href={videoUrl(platform, video.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="line-clamp-2 text-sm leading-5 hover:text-primary"
                      >
                        {title}
                      </a>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatDuration(video.durationSeconds)}
                        {video.publishedAt > 0
                          ? ` · ${new Date(video.publishedAt).toLocaleDateString("zh-CN")}`
                          : ""}
                      </p>
                      {video.tags && video.tags.length > 0 && <p className="mt-1 truncate text-xs text-primary/80">{video.tags.map((tag) => `#${tag}`).join(" ")}</p>}
                    </div>
                  </li>
                  );
                })}
              </ul>
              {scanning && (
                <div
                  aria-hidden="true"
                  className="space-y-4 py-3 motion-safe:animate-pulse"
                >
                  {[0, 1, 2].slice(0, visible.length ? 1 : 3).map((index) => (
                    <div key={index} className="flex items-center gap-3">
                      <div className="size-4 rounded bg-muted/60" />
                      <div className="h-12 w-20 rounded-md bg-muted/60" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3 w-4/5 rounded bg-muted/60" />
                        <div className="h-2.5 w-2/5 rounded bg-muted/40" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!videos.length && !scanning && (
                <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-center">
                  <Video className="size-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    {matchingCatalogue
                      ? "没有符合筛选条件的视频"
                      : "从用户主页开始，选择你想转录的视频"}
                  </p>
                </div>
              )}
              {videos.length > 30 && (
                <Pagination
                  page={currentPage}
                  total={videos.length}
                  size={30}
                  onPage={setPage}
                />
              )}
            </div>
          </section>
      </div>
    </main>
  );
}

function displayVideoTitle(video: AuthorVideo): string {
  const tags = new Set(normalizeTags(video.tags ?? []));
  if (!tags.size) return video.title;
  return video.title
    .replace(/[#＃]([^\s#＃,，]+)/gu, (hashtag, tag: string) => tags.has(normalizeSearchText(tag)) ? "" : hashtag)
    .replace(/\s+/gu, " ")
    .trim() || `视频 ${video.id}`;
}

function Pagination({
  page,
  total,
  size,
  onPage,
}: {
  page: number;
  total: number;
  size: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.ceil(total / size);
  return (
    <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
      <span className="text-xs text-muted-foreground">
        第 {page + 1} / {pages} 页
      </span>
      <div className="flex gap-2">
        <button type="button" className={`${button} h-8 px-2`} aria-label="第一页" title="第一页" disabled={!page} onClick={() => onPage(0)}><ChevronsLeft className="size-3.5" /></button>
        <button
          type="button"
          className={`${button} h-8 px-2`}
          aria-label="上一页"
          disabled={!page}
          onClick={() => onPage(page - 1)}
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <button
          type="button"
          className={`${button} h-8 px-2`}
          aria-label="下一页"
          disabled={page + 1 >= pages}
          onClick={() => onPage(page + 1)}
        >
          <ArrowRight className="size-3.5" />
        </button>
        <button type="button" className={`${button} h-8 px-2`} aria-label="最后一页" title="最后一页" disabled={page + 1 >= pages} onClick={() => onPage(pages - 1)}><ChevronsRight className="size-3.5" /></button>
      </div>
    </div>
  );
}
function formatDuration(seconds: number): string {
  return seconds > 0
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
    : "时长待确认";
}
