"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DouyinCredentialRequiredError,
  getApiError,
  readJsonPayload,
  readUserFacingError,
  requestCurrentUser,
  requireValidDouyinCredential,
} from "../_client-api";
import { DouyinAvatar } from "../_avatar";
import { DouyinUserMeta } from "../_user-meta";
import { DouyinSectionNav } from "../_section-nav";
import { DouyinLastSynced } from "../_last-synced";
import { readDouyinClientSnapshot, writeDouyinClientSnapshot } from "@/lib/douyin/client-list-cache";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type FollowingUser = {
  avatarUrl: string;
  followerCount: number;
  id: string;
  isMutual: boolean;
  name: string;
  signature: string;
  uniqueId: string;
  url: string;
  workCount: number;
};

type FollowingPayload = {
  refreshedAt: number;
  users: FollowingUser[];
};

const PAGE_SIZE = 30;
type FollowingSortOrder = "followers" | "works" | "name";

function isFollowingUser(value: unknown): value is FollowingUser {
  if (!value || typeof value !== "object") {
    return false;
  }
  const user = value as Partial<FollowingUser>;
  return typeof user.avatarUrl === "string" &&
    typeof user.followerCount === "number" &&
    typeof user.id === "string" &&
    typeof user.isMutual === "boolean" &&
    typeof user.name === "string" &&
    typeof user.signature === "string" &&
    typeof user.uniqueId === "string" &&
    typeof user.url === "string" &&
    typeof user.workCount === "number";
}

async function requestFollowing(): Promise<FollowingPayload> {
  const response = await fetch("/api/douyin/following", { cache: "no-store", method: "POST" });
  const payload = await readJsonPayload(response, "抖音关注列表获取失败。") as {
    refreshedAt?: unknown;
    users?: unknown;
  };
  const apiError = getApiError(payload);
  if (response.status === 401 && apiError?.code === "UNAUTHENTICATED") {
    throw new Error("UNAUTHENTICATED");
  }
  if (!response.ok) {
    if (apiError?.code?.startsWith("CREDENTIAL_")) {
      throw new DouyinCredentialRequiredError(apiError.error);
    }
    throw new Error(apiError?.error || "抖音关注列表获取失败。");
  }
  return {
    refreshedAt: typeof payload.refreshedAt === "number" ? payload.refreshedAt : Date.now(),
    users: Array.isArray(payload.users) ? payload.users.filter(isFollowingUser) : [],
  };
}

export function DouyinFollowingPage() {
  const router = useRouter();
  const [users, setUsers] = useState<FollowingUser[]>([]);
  const [userId, setUserId] = useState("");
  const [query, setQuery] = useState("");
  const [mutualFilter, setMutualFilter] = useState<"all" | "mutual" | "not-mutual">("all");
  const [sortOrder, setSortOrder] = useState<FollowingSortOrder>("followers");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [needsCredentialUpdate, setNeedsCredentialUpdate] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const handleError = useCallback((loadError: unknown) => {
    if (loadError instanceof Error && loadError.message === "UNAUTHENTICATED") {
      router.replace(`/login?next=${encodeURIComponent("/douyin/following")}`);
      return;
    }
    setNeedsCredentialUpdate(loadError instanceof DouyinCredentialRequiredError);
    setError(readUserFacingError(loadError, "抖音关注列表获取失败。"));
  }, [router]);

  useEffect(() => {
    let active = true;
    requestCurrentUser()
      .then(async (user) => {
        if (active) {
          setUserId(user.id);
        }
        const cache = await readDouyinClientSnapshot(user.id, "following", parseFollowingSnapshot);
        if (!active) {
          return;
        }
        if (cache) {
          setUsers(cache.data);
          setRefreshedAt(cache.refreshedAt);
          return;
        }
        await requireValidDouyinCredential();
        const payload = await requestFollowing();
        await writeDouyinClientSnapshot(user.id, "following", payload.users, payload.refreshedAt);
        if (active) {
          setUsers(payload.users);
          setRefreshedAt(payload.refreshedAt);
        }
      })
      .catch((loadError) => {
        if (active) {
          handleError(loadError);
        }
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [handleError]);

  async function refreshFollowing() {
    if (!userId) {
      return;
    }
    setIsRefreshing(true);
    setError("");
    setNeedsCredentialUpdate(false);
    try {
      await requireValidDouyinCredential();
      const payload = await requestFollowing();
      await writeDouyinClientSnapshot(userId, "following", payload.users, payload.refreshedAt);
      setUsers(payload.users);
      setRefreshedAt(payload.refreshedAt);
      setPage(1);
    } catch (loadError) {
      handleError(loadError);
    } finally {
      setIsRefreshing(false);
    }
  }

  const filteredUsers = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return users.filter((user) => {
      if (mutualFilter === "mutual" && !user.isMutual) {
        return false;
      }
      if (mutualFilter === "not-mutual" && user.isMutual) {
        return false;
      }
      return !keyword || `${user.name}\n${user.uniqueId}`.toLocaleLowerCase().includes(keyword);
    }).sort((a, b) => compareFollowingUsers(a, b, sortOrder));
  }, [mutualFilter, query, sortOrder, users]);
  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageUsers = filteredUsers.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <main className="min-h-dvh w-full bg-background text-foreground lg:h-dvh lg:overflow-hidden">
      <div className="flex min-h-dvh w-full flex-col lg:h-dvh">
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-white/10 px-4 sm:px-6 md:px-4 lg:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/"
              className="-ml-2 inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              aria-label="返回首页"
              title="返回首页"
            >
              <ArrowLeft className="size-5" strokeWidth={2} aria-hidden="true" />
            </Link>
            <h1 className="truncate text-xl font-semibold">收藏与关注</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <DouyinLastSynced refreshedAt={refreshedAt} />
            <button
              type="button"
              onClick={() => void refreshFollowing()}
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
              <DouyinSectionNav active="following" />
              <section>
                <label className="relative block">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPage(1);
                    }}
                    placeholder="搜索昵称或抖音号"
                    className="h-9 w-full rounded-md border border-white/10 bg-white/[0.04] pl-9 pr-9 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-cyan/45 focus:bg-white/[0.06]"
                  />
                  {query ? (
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setPage(1);
                      }}
                      className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
                      aria-label="清空搜索"
                      title="清空搜索"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  ) : null}
                </label>
                <div className="mt-2 flex w-full items-center justify-between gap-2">
                  <div className="inline-grid w-fit grid-cols-3 gap-1 rounded-md bg-white/[0.04] p-1" aria-label="按互关状态筛选">
                    {([
                      ["all", "全部"],
                      ["mutual", "已互关"],
                      ["not-mutual", "未互关"],
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          setMutualFilter(value);
                          setPage(1);
                        }}
                        className={`h-8 w-12 rounded text-[11px] font-medium transition-colors ${
                          mutualFilter === value
                            ? "bg-cyan/[0.14] text-cyan"
                            : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                        }`}
                        aria-pressed={mutualFilter === value}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <Select
                    value={sortOrder}
                    onValueChange={(value) => {
                      if (isFollowingSortOrder(value)) {
                        setSortOrder(value);
                        setPage(1);
                      }
                    }}
                  >
                    <SelectTrigger
                      aria-label="关注排序方式"
                      className="h-8 w-20 min-w-0 border-0 bg-white/[0.04] px-2 text-[11px] text-muted-foreground"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectItem value="followers">粉丝数</SelectItem>
                      <SelectItem value="works">作品数</SelectItem>
                      <SelectItem value="name">昵称</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </section>
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
                <FollowingSkeleton />
              ) : filteredUsers.length ? (
                <div className="content-scroll h-full overflow-y-auto">
                  {pageUsers.map((user) => (
                    <FollowingRow
                      key={user.id}
                      user={user}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState hasFilters={Boolean(query || mutualFilter !== "all")} />
              )}
            </div>
            {filteredUsers.length ? (
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

function FollowingRow({ user }: { user: FollowingUser }) {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    await navigator.clipboard.writeText(user.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <article className="flex min-h-28 items-center px-3 py-3 transition-colors hover:bg-cyan/[0.035] sm:px-4">
      <div className="flex w-full min-w-0 items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <DouyinAvatar name={user.name} url={user.avatarUrl} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={user.name}>{user.name}</p>
            <DouyinUserMeta profile={user} />
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-1">
          <button type="button" onClick={() => void copyLink()} className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.07] hover:text-foreground" aria-label="复制用户主页链接" title={copied ? "已复制" : "复制用户主页链接"}>
            {copied ? <Check className="size-4 text-cyan" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          </button>
          <a href={user.url} target="_blank" rel="noreferrer" className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.07] hover:text-cyan" aria-label="在新页面打开用户主页" title="在新页面打开用户主页">
            <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        </div>
      </div>
    </article>
  );
}

function parseFollowingSnapshot(value: unknown): FollowingUser[] | null {
  return Array.isArray(value) && value.every(isFollowingUser) ? value : null;
}

function isFollowingSortOrder(value: string): value is FollowingSortOrder {
  return value === "followers" || value === "works" || value === "name";
}

function compareFollowingUsers(a: FollowingUser, b: FollowingUser, sortOrder: FollowingSortOrder): number {
  if (sortOrder === "followers") {
    return b.followerCount - a.followerCount || b.workCount - a.workCount || a.name.localeCompare(b.name, "zh-CN");
  }
  if (sortOrder === "works") {
    return b.workCount - a.workCount || b.followerCount - a.followerCount || a.name.localeCompare(b.name, "zh-CN");
  }
  return a.name.localeCompare(b.name, "zh-CN");
}

function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (page: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={() => onChange(page - 1)} disabled={page <= 1} className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35" aria-label="上一页" title="上一页">
        <ChevronLeft className="size-4" aria-hidden="true" />
      </button>
      <span className="min-w-16 text-center text-xs tabular-nums text-muted-foreground">{page} / {totalPages}</span>
      <button type="button" onClick={() => onChange(page + 1)} disabled={page >= totalPages} className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35" aria-label="下一页" title="下一页">
        <ChevronRight className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function FollowingSkeleton() {
  return (
    <div className="h-full overflow-hidden" aria-label="正在读取关注列表">
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className="flex h-28 items-center px-4">
          <div className="grid w-full gap-3 md:grid-cols-[10rem_minmax(0,1fr)_4rem]">
            <div className="h-3 w-24 animate-pulse rounded-sm bg-white/10" style={{ animationDelay: `${index * 70}ms` }} />
            <div className="h-4 w-4/5 animate-pulse rounded-sm bg-white/10" style={{ animationDelay: `${index * 70 + 35}ms` }} />
            <div className="h-3 w-full animate-pulse rounded-sm bg-white/10" style={{ animationDelay: `${index * 70 + 70}ms` }} />
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
        <p className="text-sm font-medium">{hasFilters ? "没有符合筛选条件的用户" : "暂无关注用户"}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hasFilters ? "调整搜索内容后重试。" : "使用右上角刷新按钮同步最新关注。"}</p>
      </div>
    </div>
  );
}
