import { AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type AsrQuota = {
  configuredCustomApiKey: boolean;
  exhausted: boolean;
  limitSeconds: number;
  remainingSeconds: number;
};

export function AsrQuotaIndicator({ quota }: { quota: AsrQuota | null | undefined }) {
  if (quota === undefined) {
    return (
      <div
        className="flex h-9 items-center gap-2 whitespace-nowrap text-[11px] font-medium text-muted-foreground"
        aria-label="正在读取平台免费转录额度"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        <span>读取额度</span>
      </div>
    );
  }

  if (quota === null) {
    return (
      <div
        className="flex h-9 items-center gap-2 whitespace-nowrap text-[11px] font-medium text-amber"
        aria-label="平台免费转录额度暂时不可用"
        title="额度读取失败，请稍后重试"
      >
        <AlertCircle className="size-4" aria-hidden="true" />
        <span>额度暂不可用</span>
      </div>
    );
  }

  if (quota.configuredCustomApiKey) {
    const detail = "当前使用自定义 API Key，平台无法统计剩余转录时长";
    return (
      <div
        className="flex h-9 items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-muted-foreground/70"
        aria-label={detail}
        title={detail}
      >
        <QuotaRing />
        <span>custom apikey</span>
      </div>
    );
  }

  const remainingPercentage = quota.limitSeconds > 0
    ? Math.round(Math.min(1, quota.remainingSeconds / quota.limitSeconds) * 100)
    : 0;
  const remainingDuration = quota.exhausted ? "已用完" : `${formatQuotaMinutes(quota.remainingSeconds)} 分钟`;
  const detail = `平台免费转录额度剩余 ${remainingPercentage}%，剩余转录时长 ${remainingDuration}`;

  return (
    <div
      className={cn(
        "flex h-9 items-center justify-center gap-1.5 whitespace-nowrap text-[11px] font-medium tabular-nums sm:justify-start",
        quota.exhausted ? "text-amber" : "text-muted-foreground",
      )}
      aria-label={detail}
      title={detail}
    >
      <QuotaRing percentage={remainingPercentage} />
      <span>free:{remainingDuration}</span>
    </div>
  );
}

function QuotaRing({ percentage }: { percentage?: number }) {
  const background = percentage === undefined
    ? "rgb(34 211 238 / 0.28)"
    : `conic-gradient(rgb(34 211 238) ${percentage}%, rgb(255 255 255 / 0.1) 0)`;
  return (
    <span className="relative size-4 shrink-0 rounded-full" style={{ background }} aria-hidden="true">
      <span className="absolute inset-0.5 rounded-full bg-background" />
    </span>
  );
}

function formatQuotaMinutes(seconds: number): string {
  return Math.max(0, Math.floor(seconds / 60)).toString();
}
