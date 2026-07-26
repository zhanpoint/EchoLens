"use client";

import { RefreshCw } from "lucide-react";
import { isNetworkRetryErrorCode } from "@/lib/http/retry-ui";
import { cn } from "@/lib/utils";

export function NetworkRetryButton({
  className,
  code,
  isRetrying,
  onRetry,
}: {
  className?: string;
  code?: string;
  isRetrying: boolean;
  onRetry: () => void;
}) {
  if (!isNetworkRetryErrorCode(code)) return null;

  return (
    <button
      type="button"
      aria-label={isRetrying ? "正在重试" : "重试"}
      title={isRetrying ? "正在重试" : "重试"}
      disabled={isRetrying}
      onClick={onRetry}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-current transition hover:bg-current/10 active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      <RefreshCw className={cn("size-3.5", isRetrying && "animate-spin")} aria-hidden="true" />
    </button>
  );
}