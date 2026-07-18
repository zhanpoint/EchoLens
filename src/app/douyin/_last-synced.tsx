const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function DouyinLastSynced({ refreshedAt }: { refreshedAt: number | null }) {
  if (!refreshedAt) {
    return null;
  }

  return (
    <p className="hidden whitespace-nowrap text-sm text-muted-foreground sm:block">
      上次同步：<span className="font-medium text-foreground">{formatElapsedTime(refreshedAt)}</span>
    </p>
  );
}

function formatElapsedTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < MINUTE_MS) {
    return "刚刚";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)} 分钟前`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)} 小时前`;
  }
  return `${Math.floor(elapsed / DAY_MS)} 天前`;
}
