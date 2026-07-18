"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FolderHeart,
  Layers3,
  Loader2,
  RefreshCw,
  Search,
  Video as VideoIcon,
  X,
} from "lucide-react";
import {
  type UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DouyinCredentialRequiredError,
  getApiError,
  readJsonPayload,
  readUserFacingError,
  requestCurrentUser,
  requireValidDouyinCredential,
} from "../_client-api";
import { DouyinSectionNav } from "../_section-nav";
import { DouyinLastSynced } from "../_last-synced";
import { readDouyinClientSnapshot, writeDouyinClientSnapshot } from "@/lib/douyin/client-list-cache";
import type {
  DouyinFavoriteAuthor,
  DouyinFavoriteFolder,
  DouyinFavoriteMix,
  DouyinFavoriteVideo,
} from "@/lib/douyin/favorites";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FavoriteGroups } from "./_favorite-groups";
import { FavoriteWorkRow } from "./_favorite-work-row";

type FavoritesPayload = {
  authors: DouyinFavoriteAuthor[];
  folders: DouyinFavoriteFolder[];
  mixes: DouyinFavoriteMix[];
  refreshedAt: number;
  videos: DouyinFavoriteVideo[];
};

type FavoriteCategory = "folders" | "videos" | "mixes";
type DisplayMode = "paginated" | "virtual";
type SortOrder = "newest" | "oldest";

const PAGE_SIZE = 30;
const VIRTUAL_ROW_HEIGHT = 80;
const VIRTUAL_OVERSCAN = 6;

function isDouyinFavoriteVideo(value: unknown): value is DouyinFavoriteVideo {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<DouyinFavoriteVideo>;
  return typeof item.author === "string" &&
    typeof item.authorId === "string" &&
    typeof item.commentCount === "number" &&
    typeof item.coverUrl === "string" &&
    typeof item.favoriteCount === "number" &&
    typeof item.isFollowing === "boolean" &&
    typeof item.likeCount === "number" &&
    typeof item.publishedAt === "number" &&
    typeof item.title === "string" &&
    typeof item.url === "string";
}

function isDouyinFavoriteAuthor(value: unknown): value is DouyinFavoriteAuthor {
  if (!value || typeof value !== "object") {
    return false;
  }
  const author = value as Partial<DouyinFavoriteAuthor>;
  return typeof author.avatarUrl === "string" &&
    typeof author.followerCount === "number" &&
    typeof author.id === "string" &&
    typeof author.name === "string" &&
    typeof author.signature === "string" &&
    typeof author.uniqueId === "string" &&
    typeof author.workCount === "number";
}

function isDouyinFavoriteFolder(value: unknown): value is DouyinFavoriteFolder {
  if (!value || typeof value !== "object") {
    return false;
  }
  const folder = value as Partial<DouyinFavoriteFolder>;
  return typeof folder.id === "string" &&
    typeof folder.isPrivate === "boolean" &&
    typeof folder.name === "string" &&
    typeof folder.total === "number" &&
    Array.isArray(folder.works) && folder.works.every(isDouyinFavoriteVideo);
}

function isDouyinFavoriteMix(value: unknown): value is DouyinFavoriteMix {
  if (!value || typeof value !== "object") {
    return false;
  }
  const mix = value as Partial<DouyinFavoriteMix>;
  return typeof mix.coverUrl === "string" &&
    typeof mix.id === "string" &&
    typeof mix.name === "string" &&
    typeof mix.playCount === "number" &&
    typeof mix.total === "number" &&
    typeof mix.url === "string" &&
    Array.isArray(mix.works) && mix.works.every(isDouyinFavoriteVideo);
}

function parseFavoritesSnapshot(value: unknown): Omit<FavoritesPayload, "refreshedAt"> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const snapshot = value as { authors?: unknown; folders?: unknown; mixes?: unknown; videos?: unknown };
  if (
    !Array.isArray(snapshot.authors) ||
    !Array.isArray(snapshot.folders) ||
    !Array.isArray(snapshot.mixes) ||
    !Array.isArray(snapshot.videos)
  ) {
    return null;
  }
  if (
    !snapshot.authors.every(isDouyinFavoriteAuthor) ||
    !snapshot.folders.every(isDouyinFavoriteFolder) ||
    !snapshot.mixes.every(isDouyinFavoriteMix) ||
    !snapshot.videos.every(isDouyinFavoriteVideo)
  ) {
    return null;
  }
  return {
    authors: snapshot.authors,
    folders: snapshot.folders,
    mixes: snapshot.mixes,
    videos: snapshot.videos,
  };
}

async function requestFavorites(): Promise<FavoritesPayload> {
  const response = await fetch("/api/douyin/favorites", {
    cache: "no-store",
    method: "POST",
  });
  const payload = await readJsonPayload(response, "抖音收藏列表获取失败。") as {
    authors?: unknown;
    folders?: unknown;
    mixes?: unknown;
    refreshedAt?: unknown;
    videos?: unknown;
  };
  const apiError = getApiError(payload);
  if (response.status === 401 && apiError?.code === "UNAUTHENTICATED") {
    throw new Error("UNAUTHENTICATED");
  }
  if (!response.ok) {
    if (apiError?.code?.startsWith("CREDENTIAL_")) {
      throw new DouyinCredentialRequiredError(apiError.error);
    }
    throw new Error(apiError?.error || "抖音收藏列表获取失败。");
  }
  return {
    authors: Array.isArray(payload.authors) ? payload.authors.filter(isDouyinFavoriteAuthor) : [],
    folders: Array.isArray(payload.folders) ? payload.folders.filter(isDouyinFavoriteFolder) : [],
    mixes: Array.isArray(payload.mixes) ? payload.mixes.filter(isDouyinFavoriteMix) : [],
    refreshedAt: typeof payload.refreshedAt === "number" ? payload.refreshedAt : Date.now(),
    videos: Array.isArray(payload.videos) ? payload.videos.filter(isDouyinFavoriteVideo) : [],
  };
}

export function DouyinFavoritesPage() {
  const router = useRouter();
  const [videos, setVideos] = useState<DouyinFavoriteVideo[]>([]);
  const [authors, setAuthors] = useState<DouyinFavoriteAuthor[]>([]);
  const [folders, setFolders] = useState<DouyinFavoriteFolder[]>([]);
  const [mixes, setMixes] = useState<DouyinFavoriteMix[]>([]);
  const [activeCategory, setActiveCategory] = useState<FavoriteCategory>("folders");
  const [userId, setUserId] = useState("");
  const [dataVersion, setDataVersion] = useState(0);
  const [error, setError] = useState("");
  const [needsCredentialUpdate, setNeedsCredentialUpdate] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [followFilter, setFollowFilter] = useState<"all" | "followed" | "not-followed">("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("paginated");
  const [page, setPage] = useState(1);

  const handleRequestError = useCallback((loadError: unknown) => {
    if (loadError instanceof Error && loadError.message === "UNAUTHENTICATED") {
      router.replace(`/login?next=${encodeURIComponent("/douyin/favorites")}`);
      return;
    }
    setNeedsCredentialUpdate(loadError instanceof DouyinCredentialRequiredError);
    setError(readUserFacingError(loadError, "抖音收藏列表获取失败。"));
  }, [router]);

  useEffect(() => {
    let isActive = true;
    requestCurrentUser()
      .then(async (user) => {
        if (isActive) {
          setUserId(user.id);
        }
        const cache = await readDouyinClientSnapshot(user.id, "favorites", parseFavoritesSnapshot);
        if (!isActive) {
          return;
        }
        if (cache) {
          setAuthors(cache.data.authors);
          setFolders(cache.data.folders);
          setMixes(cache.data.mixes);
          setVideos(cache.data.videos);
          setRefreshedAt(cache.refreshedAt);
          setDataVersion((current) => current + 1);
          return;
        }
        await requireValidDouyinCredential();
        const payload = await requestFavorites();
        await writeDouyinClientSnapshot(
          user.id,
          "favorites",
          {
            authors: payload.authors,
            folders: payload.folders,
            mixes: payload.mixes,
            videos: payload.videos,
          },
          payload.refreshedAt,
        );
        if (isActive) {
          setAuthors(payload.authors);
          setFolders(payload.folders);
          setMixes(payload.mixes);
          setVideos(payload.videos);
          setRefreshedAt(payload.refreshedAt);
          setDataVersion((current) => current + 1);
        }
      })
      .catch((loadError) => {
        if (isActive) {
          handleRequestError(loadError);
        }
      })
      .finally(() => {
        if (isActive) {
          setIsLoading(false);
        }
      });
    return () => {
      isActive = false;
    };
  }, [handleRequestError]);

  async function refreshFavorites() {
    if (!userId) {
      return;
    }
    setIsRefreshing(true);
    setError("");
    setNeedsCredentialUpdate(false);
    try {
      await requireValidDouyinCredential();
      const payload = await requestFavorites();
      await writeDouyinClientSnapshot(
        userId,
        "favorites",
        {
          authors: payload.authors,
          folders: payload.folders,
          mixes: payload.mixes,
          videos: payload.videos,
        },
        payload.refreshedAt,
      );
      setAuthors(payload.authors);
      setFolders(payload.folders);
      setMixes(payload.mixes);
      setVideos(payload.videos);
      setRefreshedAt(payload.refreshedAt);
      setDataVersion((current) => current + 1);
    } catch (loadError) {
      handleRequestError(loadError);
    } finally {
      setIsRefreshing(false);
    }
  }

  const filteredVideos = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    const filtered = videos.filter((video) => {
      if (followFilter === "followed" && !video.isFollowing) {
        return false;
      }
      if (followFilter === "not-followed" && video.isFollowing) {
        return false;
      }
      return !keyword || `${video.author}\n${video.title}`.toLocaleLowerCase().includes(keyword);
    });
    return filtered.sort((a, b) => comparePublishedAt(a, b, sortOrder));
  }, [followFilter, query, sortOrder, videos]);

  const authorByKey = useMemo(
    () => new Map(
      authors.flatMap((author) => [
        ...(author.id ? [[author.id, author] as const] : []),
        [author.name, author] as const,
      ]),
    ),
    [authors],
  );

  const totalPages = Math.max(1, Math.ceil(filteredVideos.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageVideos = filteredVideos.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const searchPlaceholder = activeCategory === "folders"
    ? "搜索收藏夹或作品"
    : activeCategory === "mixes"
      ? "搜索合集或作品"
      : "搜索作者或标题";

  return (
    <main className="min-h-dvh w-full bg-background text-foreground lg:h-dvh lg:overflow-hidden">
      <div className="flex min-h-dvh w-full flex-col lg:h-dvh">
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-white/10 px-4 sm:px-6 lg:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/"
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground active:bg-white/[0.1]"
              aria-label="返回首页"
              title="返回首页"
            >
              <ArrowLeft className="size-5" strokeWidth={2} aria-hidden="true" />
            </Link>
            <h1 className="truncate text-xl font-semibold text-foreground">收藏与关注</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <DouyinLastSynced refreshedAt={refreshedAt} />
            <button
              type="button"
              onClick={() => void refreshFavorites()}
              disabled={isLoading || isRefreshing}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold text-cyan transition-colors hover:bg-cyan/[0.1] active:bg-cyan/[0.16] disabled:cursor-not-allowed disabled:text-muted-foreground"
            >
              {isRefreshing ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-4" aria-hidden="true" />
              )}
              {isRefreshing ? "同步中" : "刷新"}
            </button>
          </div>
        </header>

        <div className="grid flex-1 lg:min-h-0 lg:grid-cols-[clamp(18rem,22vw,23rem)_minmax(0,1fr)]">
          <aside className="border-b border-white/10 px-4 pb-4 pt-2 sm:px-6 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:px-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
              <DouyinSectionNav active="favorites" />
              <FavoriteCategoryNav
                active={activeCategory}
                counts={{ folders: folders.length, mixes: mixes.length, videos: videos.length }}
                onChange={(category) => {
                  setActiveCategory(category);
                  setQuery("");
                  setPage(1);
                }}
              />
              <section className="min-w-0 sm:col-span-2 lg:col-span-1">
                <label className="relative mb-2 block">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPage(1);
                    }}
                    placeholder={searchPlaceholder}
                    className="h-8 w-full rounded-md border border-white/10 bg-white/[0.035] pl-8 pr-8 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-cyan/40 focus:bg-white/[0.05]"
                  />
                  {query ? (
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setPage(1);
                      }}
                      className="absolute right-1 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
                      aria-label="清空搜索"
                      title="清空搜索"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                </label>
                {activeCategory === "videos" ? (
                  <div className="grid grid-cols-2 gap-5 rounded-md bg-white/[0.035] px-2 py-1.5">
                    <FilterSelectRow
                      label="关注状态："
                      value={followFilter}
                      onValueChange={(value) => {
                        setFollowFilter(value as "all" | "followed" | "not-followed");
                        setPage(1);
                      }}
                      ariaLabel="按关注状态筛选"
                      options={[
                        { value: "all", label: "全部" },
                        { value: "followed", label: "已关注" },
                        { value: "not-followed", label: "未关注" },
                      ]}
                    />
                    <FilterSelectRow
                      label="发布时间："
                      value={sortOrder}
                      onValueChange={(value) => {
                        setSortOrder(value as SortOrder);
                        setPage(1);
                      }}
                      ariaLabel="按发布时间排序"
                      options={[
                        { value: "newest", label: "最新" },
                        { value: "oldest", label: "最早" },
                      ]}
                    />
                  </div>
                ) : null}
              </section>

              {activeCategory === "videos" ? (
                <section className="flex min-w-0 items-center justify-between gap-3 sm:col-span-2 lg:col-span-1">
                  <h2 className="shrink-0 text-xs font-normal text-cyan">显示方式</h2>
                  <div className="grid w-32 grid-cols-2 rounded-full bg-white/[0.045] p-0.5" role="group" aria-label="显示方式">
                    <ModeButton
                      active={displayMode === "paginated"}
                      onClick={() => {
                        setDisplayMode("paginated");
                        setPage(1);
                      }}
                      label="分页渲染"
                    />
                    <ModeButton
                      active={displayMode === "virtual"}
                      onClick={() => {
                        setDisplayMode("virtual");
                        setPage(1);
                      }}
                      label="虚拟滚动"
                    />
                  </div>
                </section>
              ) : null}
            </div>
          </aside>

          <section className="flex min-w-0 flex-col px-4 py-4 sm:px-6 lg:min-h-0 lg:px-6">
            {error ? (
              <div className="mb-3 shrink-0 rounded-md border border-amber/25 bg-amber/[0.08] px-3 py-2 text-sm text-amber">
                {error}
                {needsCredentialUpdate ? (
                  <Link href="/settings" className="ml-2 font-semibold underline underline-offset-4">
                    前往设置
                  </Link>
                ) : null}
              </div>
            ) : null}

            <div className="min-h-[22rem] flex-1 overflow-hidden lg:min-h-0">
              {isLoading || isRefreshing ? (
                activeCategory === "videos" ? <FavoritesSkeleton /> : <GroupsSkeleton />
              ) : activeCategory === "folders" ? (
                <FavoriteGroups key="folders" authors={authors} groups={folders} kind="folder" query={query} />
              ) : activeCategory === "mixes" ? (
                <FavoriteGroups key="mixes" authors={authors} groups={mixes} kind="mix" query={query} />
              ) : filteredVideos.length ? (
                displayMode === "virtual" ? (
                  <VirtualFavoritesList
                    key={`${followFilter}\u0000${query}\u0000${sortOrder}\u0000${dataVersion}`}
                    authorByKey={authorByKey}
                    videos={filteredVideos}
                  />
                ) : (
                  <div className="content-scroll h-full overflow-y-auto">
                    {pageVideos.map((video) => (
                      <FavoriteWorkRow
                        key={video.url}
                        author={authorByKey.get(video.authorId || video.author)}
                        video={video}
                      />
                    ))}
                  </div>
                )
              ) : (
                <EmptyState hasFilters={Boolean(query || followFilter !== "all")} />
              )}
            </div>

            {activeCategory === "videos" && displayMode === "paginated" && filteredVideos.length ? (
              <div className="mt-3 flex shrink-0 justify-end">
                <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} />
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}

function FavoriteCategoryNav({
  active,
  counts,
  onChange,
}: {
  active: FavoriteCategory;
  counts: Record<FavoriteCategory, number>;
  onChange: (category: FavoriteCategory) => void;
}) {
  const items = [
    { icon: FolderHeart, id: "folders" as const, label: "收藏夹" },
    { icon: VideoIcon, id: "videos" as const, label: "视频" },
    { icon: Layers3, id: "mixes" as const, label: "合集" },
  ];
  return (
    <nav className="grid gap-1 sm:self-start lg:w-full" aria-label="收藏分类">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => onChange(item.id)}
            className={`flex h-9 min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors active:bg-cyan/[0.12] ${
              isActive
                ? "bg-cyan/[0.1] text-cyan"
                : "text-muted-foreground hover:bg-white/[0.045] hover:text-foreground"
            }`}
          >
            <Icon className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <span className="shrink-0 text-xs tabular-nums opacity-75">{counts[item.id]} 个</span>
          </button>
        );
      })}
    </nav>
  );
}

function FilterSelectRow({
  ariaLabel,
  label,
  onValueChange,
  options,
  value,
}: {
  ariaLabel: string;
  label: string;
  onValueChange: (value: string) => void;
  options: readonly { label: string; value: string }[];
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-center">
      <span className="shrink-0 whitespace-nowrap text-xs text-cyan">{label}</span>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger
          aria-label={ariaLabel}
          className="w-[4.25rem] min-w-0 justify-between whitespace-nowrap pl-0 pr-1.5 text-muted-foreground"
        >
          <SelectValue className="shrink-0 whitespace-nowrap" />
        </SelectTrigger>
        <SelectContent align="end">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ModeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`h-6 whitespace-nowrap rounded-full px-1.5 text-[0.6875rem] font-medium leading-none transition-colors ${
        active ? "bg-surface-strong text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function Pagination({
  onChange,
  page,
  totalPages,
}: {
  onChange: (page: number) => void;
  page: number;
  totalPages: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
        aria-label="上一页"
        title="上一页"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
      </button>
      <span className="min-w-16 text-center text-xs tabular-nums text-muted-foreground">{page} / {totalPages}</span>
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={page >= totalPages}
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
        aria-label="下一页"
        title="下一页"
      >
        <ChevronRight className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function VirtualFavoritesList({
  authorByKey,
  videos,
}: {
  authorByKey: ReadonlyMap<string, DouyinFavoriteAuthor>;
  videos: DouyinFavoriteVideo[];
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const updateHeight = () => setViewportHeight(viewport.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2;
  const end = Math.min(videos.length, start + visibleCount);

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    setScrollTop(event.currentTarget.scrollTop);
  }

  return (
    <div
      ref={viewportRef}
      onScroll={handleScroll}
      className="content-scroll h-[min(70dvh,48rem)] overflow-y-auto lg:h-full"
    >
      <div className="relative w-full" style={{ height: videos.length * VIRTUAL_ROW_HEIGHT }}>
        {videos.slice(start, end).map((video, offset) => {
          const index = start + offset;
          return (
            <div
              key={video.url}
              className="absolute inset-x-0"
              style={{ height: VIRTUAL_ROW_HEIGHT, top: index * VIRTUAL_ROW_HEIGHT }}
            >
              <FavoriteWorkRow
                author={authorByKey.get(video.authorId || video.author)}
                video={video}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FavoritesSkeleton() {
  return (
    <div className="h-full overflow-hidden" aria-label="正在读取收藏列表">
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className="flex h-20 items-center px-4">
          <div className="grid w-full gap-3 md:grid-cols-[10rem_minmax(0,1fr)_6rem]">
            <div className="flex items-center gap-2">
              <div className="size-8 animate-pulse rounded-full bg-white/10" style={{ animationDelay: `${index * 70}ms` }} />
              <div className="h-3 w-20 animate-pulse rounded-sm bg-white/10" style={{ animationDelay: `${index * 70}ms` }} />
            </div>
            <div className="h-4 w-4/5 animate-pulse rounded-sm bg-white/10" style={{ animationDelay: `${index * 70 + 35}ms` }} />
            <div className="h-3 w-full animate-pulse rounded-sm bg-white/10" style={{ animationDelay: `${index * 70 + 70}ms` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function GroupsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 overflow-hidden xl:grid-cols-2" aria-label="正在读取收藏分组">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="min-h-40 animate-pulse rounded-md border border-white/[0.06] bg-white/[0.035] p-4" style={{ animationDelay: `${index * 60}ms` }}>
          <div className="flex items-center justify-between gap-4">
            <div className="h-4 w-28 rounded-sm bg-white/10" />
            <div className="h-3 w-14 rounded-sm bg-white/[0.08]" />
          </div>
          <div className="mt-4 grid grid-cols-6 gap-2">
            {Array.from({ length: 6 }, (_, coverIndex) => (
              <div key={coverIndex} className="aspect-square rounded-md bg-white/[0.08]" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="flex h-full min-h-[22rem] items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          {hasFilters ? "没有符合筛选条件的视频" : "暂无收藏视频"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {hasFilters ? "调整搜索内容或作者筛选后重试。" : "使用右上角刷新按钮同步最新收藏。"}
        </p>
      </div>
    </div>
  );
}

function comparePublishedAt(
  a: DouyinFavoriteVideo,
  b: DouyinFavoriteVideo,
  order: SortOrder,
): number {
  if (!a.publishedAt) {
    return b.publishedAt ? 1 : 0;
  }
  if (!b.publishedAt) {
    return -1;
  }
  return order === "newest"
    ? b.publishedAt - a.publishedAt
    : a.publishedAt - b.publishedAt;
}
