"use client";

import Link from "next/link";
import { AudioLines, Bookmark, Check, Copy, ExternalLink, Heart, MessageCircleMore } from "lucide-react";
import { useState } from "react";
import type { DouyinFavoriteAuthor, DouyinFavoriteVideo } from "@/lib/douyin/favorites";
import { DouyinAvatar } from "../_avatar";
import { formatDouyinCount } from "../_user-meta";

const SOCIAL_TOKEN_PATTERN = /([#@][\p{L}\p{N}_-]+)/gu;
const PUBLISHED_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Shanghai",
  year: "numeric",
});
const WORK_METRICS = [
  { field: "likeCount", icon: Heart, iconClassName: "text-[#fe2c55]", label: "点赞" },
  { field: "favoriteCount", icon: Bookmark, iconClassName: "text-[#f7c948]", label: "收藏" },
  { field: "commentCount", icon: MessageCircleMore, iconClassName: "text-[#25f4ee]", label: "评论" },
] as const;

export function FavoriteWorkRow({
  author,
  video,
}: {
  author?: DouyinFavoriteAuthor;
  video: DouyinFavoriteVideo;
}) {
  const [copied, setCopied] = useState(false);
  const authorName = author?.name || video.author;

  async function copyLink() {
    await navigator.clipboard.writeText(video.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <article className="flex min-h-20 min-w-0 items-center px-3 py-2 transition-colors hover:bg-cyan/[0.035] sm:px-4 md:h-20 md:py-0">
      <div className="grid w-full min-w-0 gap-x-5 gap-y-1.5 md:grid-cols-[minmax(9rem,14rem)_minmax(0,1fr)_auto] md:items-center">
        <div className="flex min-w-0 items-center gap-2.5">
          <DouyinAvatar name={authorName} url={author?.avatarUrl ?? ""} />
          <p className="truncate text-sm font-medium text-foreground" title={authorName}>{authorName}</p>
        </div>
        <div className="min-w-0">
          <h2 className="line-clamp-2 text-xs font-normal leading-5 text-foreground" title={video.title}>
            {renderSocialTokens(video.title)}
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
            {video.publishedAt > 0 ? (
              <time dateTime={new Date(video.publishedAt * 1_000).toISOString()}>
                发布于 {PUBLISHED_DATE_FORMATTER.format(video.publishedAt * 1_000)}
              </time>
            ) : null}
            {WORK_METRICS.map(({ field, icon: Icon, iconClassName, label }) => {
              const formatted = formatDouyinCount(video[field]);
              return (
                <span
                  key={label}
                  className="inline-flex items-center gap-1"
                  aria-label={`${label} ${formatted}`}
                  title={`${label} ${formatted}`}
                >
                  <Icon className={`size-3 ${iconClassName}`} aria-hidden="true" />
                  {formatted}
                </span>
              );
            })}
          </div>
        </div>
        <div className="flex items-center justify-end gap-1">
          <Link
            href={{ pathname: "/", query: { transcribe: video.url } }}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-cyan/[0.07] hover:text-cyan"
            aria-label="转录此作品"
            title="转录此作品"
          >
            <AudioLines className="size-4 text-cyan motion-safe:animate-pulse" aria-hidden="true" />
          </Link>
          <button
            type="button"
            onClick={() => void copyLink()}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground"
            aria-label="复制视频链接"
            title={copied ? "已复制" : "复制视频链接"}
          >
            {copied ? <Check className="size-4 text-cyan" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          </button>
          <a
            href={video.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-cyan"
            aria-label="在新页面打开视频"
            title="在新页面打开视频"
          >
            <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        </div>
      </div>
    </article>
  );
}

function renderSocialTokens(text: string) {
  return text.split(SOCIAL_TOKEN_PATTERN).map((token, index) => {
    if (!token) {
      return null;
    }
    if (token.startsWith("#")) {
      return (
        <span key={`${index}-${token}`} className="mx-0.5 inline-flex rounded-sm bg-[#9bb892]/10 px-1.5 py-0.5 text-[#adc4a3]">
          {token}
        </span>
      );
    }
    if (token.startsWith("@")) {
      return (
        <span key={`${index}-${token}`} className="mx-0.5 inline-flex rounded-sm bg-cyan/[0.08] px-1.5 py-0.5 text-cyan">
          {token}
        </span>
      );
    }
    return <span key={`${index}-${token.slice(0, 8)}`}>{token}</span>;
  });
}
