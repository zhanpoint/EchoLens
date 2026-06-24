import { NextResponse } from "next/server";

const CLEANUP_INTERVAL_MS = 60_000;
const MAX_BUCKETS = 4_096;

export type UserRateLimitRoute =
  | "douyin:extract"
  | "douyin:summarize";

type LimitConfig = {
  limit: number;
};

type UsageWindow = {
  count: number;
  expiresAt: number;
  lastSeenAt: number;
};

type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; resetAt: number; retryAfter: number };

const LIMITS = {
  "douyin:extract": { limit: 50 },
  "douyin:summarize": { limit: 100 },
} satisfies Record<UserRateLimitRoute, LimitConfig>;

const usageWindows = new Map<string, UsageWindow>();
let lastCleanupAt = 0;

export async function withUserRateLimit(
  userId: string,
  route: UserRateLimitRoute,
  handler: () => Promise<Response>,
): Promise<Response> {
  const decision = consumeUserRateLimit(userId, route);
  if (!decision.allowed) {
    return rateLimitedJson(decision);
  }

  return await handler();
}

function consumeUserRateLimit(userId: string, route: UserRateLimitRoute): RateLimitDecision {
  const now = Date.now();
  cleanupBuckets(now);

  const limit = LIMITS[route];
  const key = `${route}:${userId}`;
  const usage = readUsageWindow(key, now);
  if (usage.count >= limit.limit) {
    return {
      allowed: false,
      resetAt: usage.expiresAt,
      retryAfter: Math.max(1, Math.ceil((usage.expiresAt - now) / 1000)),
    };
  }

  usage.count += 1;
  usage.lastSeenAt = now;
  usageWindows.set(key, usage);
  trimBuckets();

  return { allowed: true };
}

function readUsageWindow(key: string, now: number): UsageWindow {
  const existing = usageWindows.get(key);
  if (!existing || existing.expiresAt <= now) {
    return {
      count: 0,
      expiresAt: nextLocalMidnight(now),
      lastSeenAt: now,
    };
  }

  existing.lastSeenAt = now;
  return existing;
}

function cleanupBuckets(now: number): void {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }

  lastCleanupAt = now;
  for (const [key, usage] of usageWindows) {
    if (usage.expiresAt <= now) {
      usageWindows.delete(key);
    }
  }
  trimBuckets();
}

function trimBuckets(): void {
  if (usageWindows.size <= MAX_BUCKETS) {
    return;
  }

  const overflow = usageWindows.size - MAX_BUCKETS;
  const staleKeys = [...usageWindows.entries()]
    .sort(([, left], [, right]) => left.expiresAt - right.expiresAt || left.lastSeenAt - right.lastSeenAt)
    .slice(0, overflow)
    .map(([key]) => key);

  for (const key of staleKeys) {
    usageWindows.delete(key);
  }
}

function rateLimitedJson(decision: Extract<RateLimitDecision, { allowed: false }>): NextResponse {
  const response = NextResponse.json(
    {
      error: `您已达到今日使用上限，请于${formatResetTime(decision.resetAt)} 后继续使用。`,
      resetAt: new Date(decision.resetAt).toISOString(),
      retryAfter: decision.retryAfter,
    },
    { status: 429 },
  );
  response.headers.set("Retry-After", String(decision.retryAfter));
  return response;
}

function nextLocalMidnight(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function formatResetTime(resetAt: number): string {
  const date = new Date(resetAt);
  return `明天 ${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

export function resetUserRateLimitsForTest(): void {
  usageWindows.clear();
  lastCleanupAt = 0;
}
