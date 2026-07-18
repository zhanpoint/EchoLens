import type { DouyinFavoriteAuthor } from "@/lib/douyin/favorites";
import type { DouyinFollowingUser } from "@/lib/douyin/following";

type DouyinUserProfile = Pick<
  DouyinFavoriteAuthor | DouyinFollowingUser,
  "followerCount" | "signature" | "uniqueId" | "workCount"
>;

export function DouyinUserMeta({ profile }: { profile?: DouyinUserProfile }) {
  if (!profile) {
    return null;
  }

  return (
    <div className="min-w-0">
      <p className="truncate text-xs leading-5 text-muted-foreground" title={profile.uniqueId}>
        <span className="text-foreground/70">抖音号：</span>{profile.uniqueId || "暂无"}
      </p>
      <div className="flex flex-wrap gap-x-2 text-xs leading-5 tabular-nums text-muted-foreground">
        <span><span className="text-foreground/70">粉丝：</span>{formatDouyinCount(profile.followerCount)}</span>
        <span><span className="text-foreground/70">作品：</span>{formatDouyinCount(profile.workCount)}</span>
      </div>
      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground" title={profile.signature}>
        <span className="text-foreground/70">简介：</span>{profile.signature || "暂无简介"}
      </p>
    </div>
  );
}

export function formatDouyinCount(value: number): string {
  if (value >= 100_000_000) {
    return `${trimDecimal(value / 100_000_000)}亿`;
  }
  if (value >= 10_000) {
    return `${trimDecimal(value / 10_000)}万`;
  }
  return new Intl.NumberFormat("zh-CN").format(value);
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, "");
}
