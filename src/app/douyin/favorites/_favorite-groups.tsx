"use client";

import { ArrowLeft, ArrowRight, ExternalLink, Folder, Layers3, LibraryBig, Play } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type {
  DouyinFavoriteFolder,
  DouyinFavoriteMix,
} from "@/lib/douyin/favorites";
import { formatDouyinCount } from "../_user-meta";

const DOUYIN_FAVORITES_URL = "https://www.douyin.com/user/self?showTab=favorite_collection";

type FavoriteGroupsProps = {
  children?: ReactNode;
  groups: DouyinFavoriteFolder[] | DouyinFavoriteMix[];
  kind: "folder" | "mix";
  onSelectedIdChange: (id: string) => void;
  query: string;
  selectedId: string;
};

export function FavoriteGroups({
  children,
  groups,
  kind,
  onSelectedIdChange,
  query,
  selectedId,
}: FavoriteGroupsProps) {
  const keyword = query.trim().toLocaleLowerCase();
  const filteredGroups = useMemo(
    () => groups.filter((group) => !keyword || group.name.toLocaleLowerCase().includes(keyword)),
    [groups, keyword],
  );
  const selected = groups.find((group) => group.id === selectedId);

  if (selected) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.08] px-1 pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onSelectedIdChange("")}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground active:bg-white/[0.1]"
              aria-label={`返回${kind === "folder" ? "收藏夹" : "合集"}列表`}
              title={`返回${kind === "folder" ? "收藏夹" : "合集"}列表`}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
            </button>
            <h2 className="truncate text-sm font-semibold text-foreground">{selected.name}</h2>
          </div>
          {kind === "mix" ? (
            <a
              href={(selected as DouyinFavoriteMix).url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-cyan"
              aria-label="在抖音打开合集"
              title="在抖音打开合集"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
            </a>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 pt-1">{children}</div>
      </div>
    );
  }

  if (!filteredGroups.length) {
    return (
      <GroupEmptyState
        label={keyword
          ? `没有符合搜索条件的${kind === "folder" ? "收藏夹" : "合集"}`
          : `暂无${kind === "folder" ? "收藏夹" : "收藏合集"}`}
      />
    );
  }

  return (
    <div className="content-scroll h-full overflow-y-auto pr-1">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {filteredGroups.map((group) => (
          kind === "folder" ? (
            <FolderCard
              key={group.id}
              folder={group as DouyinFavoriteFolder}
              onOpen={() => onSelectedIdChange(group.id)}
            />
          ) : (
            <MixCard
              key={group.id}
              mix={group as DouyinFavoriteMix}
              onOpen={() => onSelectedIdChange(group.id)}
            />
          )
        ))}
      </div>
    </div>
  );
}

function FolderCard({ folder, onOpen }: { folder: DouyinFavoriteFolder; onOpen: () => void }) {
  const previews = folder.works.filter((work) => work.coverUrl).slice(0, 5);
  return (
    <article className="group relative min-h-40 rounded-md border border-white/[0.08] bg-white/[0.035] transition-colors hover:border-cyan/30 hover:bg-cyan/[0.045]">
      <button
        type="button"
        onClick={onOpen}
        className="h-full w-full p-4 pr-14 text-left active:bg-cyan/[0.07]"
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan/[0.1] text-cyan">
            <LibraryBig className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground" title={folder.name}>{folder.name}</h2>
            <p className="mt-1 text-xs tabular-nums text-muted-foreground">共 {folder.total} 个作品</p>
          </div>
        </div>
        {previews.length ? (
          <div className="mt-4 grid grid-cols-5 gap-2">
            {previews.map((work) => (
              <MediaCover key={work.url} alt="" url={work.coverUrl} />
            ))}
          </div>
        ) : (
          <div className="mt-4 flex h-[4.25rem] items-center gap-2 rounded-md bg-white/[0.025] px-3 text-xs text-muted-foreground">
            <Folder className="size-4" aria-hidden="true" />
            暂无作品封面
          </div>
        )}
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-md bg-cyan/[0.1] text-cyan transition-colors hover:bg-cyan/[0.18] active:bg-cyan/[0.24]"
        aria-label={`进入收藏夹 ${folder.name}`}
        title={`进入收藏夹 ${folder.name}`}
      >
        <ArrowRight className="size-4" aria-hidden="true" />
      </button>
      <a
        href={DOUYIN_FAVORITES_URL}
        target="_blank"
        rel="noreferrer"
        className="absolute right-12 top-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-cyan"
        aria-label={`在抖音打开收藏夹 ${folder.name}`}
        title={`在抖音打开收藏夹 ${folder.name}`}
      >
        <ExternalLink className="size-4" aria-hidden="true" />
      </a>
    </article>
  );
}

function MixCard({ mix, onOpen }: { mix: DouyinFavoriteMix; onOpen: () => void }) {
  const creator = mix.works[0]?.author;

  return (
    <article className="group relative min-h-28 rounded-md border border-white/[0.08] bg-white/[0.035] transition-colors hover:border-cyan/30 hover:bg-cyan/[0.045]">
      <button
        type="button"
        onClick={onOpen}
        className="grid h-full w-full grid-cols-[5.5rem_minmax(0,1fr)] gap-3 p-3 pr-14 text-left active:bg-cyan/[0.07]"
      >
        <MediaCover alt="" className="aspect-square" fallback="mix" url={mix.coverUrl} />
        <div className="flex min-w-0 flex-col justify-center">
          <h2 className="line-clamp-2 text-sm font-semibold leading-5 text-foreground" title={mix.name}>{mix.name}</h2>
          {creator ? (
            <p className="mt-1 truncate text-xs text-muted-foreground" title={creator}>创建者 {creator}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
            <span>{mix.total} 个作品</span>
            {mix.playCount > 0 ? (
              <span className="flex items-center gap-1.5">
                <Play className="size-3 fill-current" aria-hidden="true" />
                {formatDouyinCount(mix.playCount)} 次播放
              </span>
            ) : null}
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-md bg-cyan/[0.1] text-cyan transition-colors hover:bg-cyan/[0.18] active:bg-cyan/[0.24]"
        aria-label={`进入合集 ${mix.name}`}
        title={`进入合集 ${mix.name}`}
      >
        <ArrowRight className="size-4" aria-hidden="true" />
      </button>
      <a
        href={mix.url}
        target="_blank"
        rel="noreferrer"
        className="absolute right-12 top-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-cyan"
        aria-label="在抖音打开合集"
        title="在抖音打开合集"
      >
        <ExternalLink className="size-4" aria-hidden="true" />
      </a>
    </article>
  );
}

function MediaCover({
  alt,
  className = "aspect-square",
  fallback = "work",
  url,
}: {
  alt: string;
  className?: string;
  fallback?: "mix" | "work";
  url: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <span className={`${className} flex min-w-0 items-center justify-center overflow-hidden rounded-md bg-white/[0.055] text-muted-foreground`} aria-hidden="true">
        {fallback === "mix" ? <Layers3 className="size-5" /> : <Play className="size-4" />}
      </span>
    );
  }
  return (
    // Covers use arbitrary Douyin CDN hosts, so the browser loads them directly.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      className={`${className} min-w-0 rounded-md object-cover`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function GroupEmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[22rem] items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-1 text-xs text-muted-foreground">使用右上角刷新按钮同步最新收藏。</p>
      </div>
    </div>
  );
}
