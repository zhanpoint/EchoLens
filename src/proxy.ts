import { NextRequest, NextResponse } from "next/server";
import {
  CLIENT_COOKIE,
  CLIENT_COOKIE_MAX_AGE_SECONDS,
  createClientId,
  firstHeaderValue,
  normalizeClientId,
  readAnonymousIdentity,
  readClientIp,
  stableHash,
  type ClientIdentity,
} from "@/lib/request-identity";

const CLEANUP_INTERVAL_MS = 60_000;
// 1GB single-instance hosts should keep middleware state comfortably below app/runtime memory.
const MAX_BUCKETS = 4_096;

type ApiRouteKind = "download" | "expensive" | "resolve";

type LimitRule = {
  key: string;
  limit: number;
  windowMs: number;
};

type TokenBucket = {
  expiresAt: number;
  lastSeenAt: number;
  tokens: number;
  updatedAt: number;
};

type RateLimitDecision =
  | { allowed: true; limit: number; remaining: number; resetAt: number }
  | { allowed: false; limit: number; retryAfter: number; resetAt: number };

const buckets = new Map<string, TokenBucket>();
let lastCleanupAt = 0;

export function proxy(request: NextRequest) {
  const client = readClientIdentity(request);

  if (!isDouyinApiRequest(request)) {
    return withClientCookie(NextResponse.next(), request, client);
  }

  const limit = checkRateLimit(request, client);
  if (!limit.allowed) {
    return withRateLimitHeaders(
      NextResponse.json(
        {
          error: `请求太频繁，请 ${limit.retryAfter} 秒后再试。`,
          code: "RATE_LIMITED",
        },
        { status: 429 },
      ),
      limit,
    );
  }

  return withRateLimitHeaders(withClientCookie(NextResponse.next(), request, client), limit);
}

function isDouyinApiRequest(request: NextRequest): boolean {
  return request.nextUrl.pathname.startsWith("/api/douyin/");
}

function readClientIdentity(request: NextRequest): ClientIdentity {
  const cookieId = normalizeClientId(request.cookies.get(CLIENT_COOKIE)?.value);
  if (cookieId) {
    return { id: cookieId, isNew: false };
  }

  return { id: createClientId(), isNew: true };
}

function withClientCookie(
  response: NextResponse,
  request: NextRequest,
  client: ClientIdentity,
): NextResponse {
  if (!client.isNew) {
    return response;
  }

  response.cookies.set(CLIENT_COOKIE, client.id, {
    httpOnly: true,
    maxAge: CLIENT_COOKIE_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: isSecureRequest(request),
  });
  return response;
}

function isSecureRequest(request: NextRequest): boolean {
  return (
    firstHeaderValue(request.headers.get("x-forwarded-proto")) === "https" ||
    request.nextUrl.protocol === "https:"
  );
}

function checkRateLimit(
  request: NextRequest,
  client: ClientIdentity,
): RateLimitDecision {
  const now = Date.now();
  cleanupBuckets(now);

  const rules = buildLimitRules(request, client);
  const blocked = rules
    .map((rule) => ({ rule, bucket: readBucket(rule, now) }))
    .find(({ bucket }) => bucket.tokens < 1);

  if (blocked) {
    const refillMs = ((1 - blocked.bucket.tokens) * blocked.rule.windowMs) / blocked.rule.limit;
    return {
      allowed: false,
      limit: blocked.rule.limit,
      resetAt: now + refillMs,
      retryAfter: Math.max(1, Math.ceil(refillMs / 1000)),
    };
  }

  const snapshots = rules.map((rule) => {
    const bucket = readBucket(rule, now);
    bucket.tokens -= 1;
    buckets.set(rule.key, bucket);
    return { rule, bucket };
  });
  trimBuckets();

  const tightest = snapshots.reduce((current, next) => {
    const currentRemaining = Math.floor(current.bucket.tokens);
    const nextRemaining = Math.floor(next.bucket.tokens);
    return nextRemaining < currentRemaining ? next : current;
  });

  return {
    allowed: true,
    limit: tightest.rule.limit,
    remaining: Math.max(0, Math.floor(tightest.bucket.tokens)),
    resetAt: tightest.bucket.expiresAt,
  };
}

function buildLimitRules(
  request: NextRequest,
  client: ClientIdentity,
): LimitRule[] {
  const routeKind = readApiRouteKind(request.nextUrl.pathname);
  const identity = client.isNew ? readAnonymousIdentity(request.headers) : stableHash(`client|${client.id}`);
  const ipHash = stableHash(readClientIp(request.headers));
  const limits = readLimits(routeKind, client.isNew);

  return [
    { key: `${routeKind}:client:${identity}:minute`, limit: limits.clientMinute, windowMs: 60_000 },
    { key: `${routeKind}:client:${identity}:hour`, limit: limits.clientHour, windowMs: 3_600_000 },
    { key: `${routeKind}:ip:${ipHash}:minute`, limit: limits.ipMinute, windowMs: 60_000 },
    { key: `${routeKind}:ip:${ipHash}:hour`, limit: limits.ipHour, windowMs: 3_600_000 },
  ];
}

function readApiRouteKind(pathname: string): ApiRouteKind {
  if (pathname.includes("/download")) {
    return "download";
  }
  if (pathname.includes("/extract") || pathname.includes("/summarize")) {
    return "expensive";
  }
  return "resolve";
}

function readLimits(
  routeKind: ApiRouteKind,
  isAnonymous: boolean,
): { clientMinute: number; clientHour: number; ipMinute: number; ipHour: number } {
  const limits = {
    download: { clientMinute: 30, clientHour: 180, ipMinute: 120, ipHour: 720 },
    expensive: { clientMinute: 6, clientHour: 40, ipMinute: 30, ipHour: 180 },
    resolve: { clientMinute: 20, clientHour: 120, ipMinute: 80, ipHour: 500 },
  } satisfies Record<ApiRouteKind, { clientMinute: number; clientHour: number; ipMinute: number; ipHour: number }>;

  if (!isAnonymous) {
    return limits[routeKind];
  }

  return {
    clientMinute: Math.max(2, Math.floor(limits[routeKind].clientMinute / 3)),
    clientHour: Math.max(10, Math.floor(limits[routeKind].clientHour / 3)),
    ipMinute: limits[routeKind].ipMinute,
    ipHour: limits[routeKind].ipHour,
  };
}

function readBucket(rule: LimitRule, now: number): TokenBucket {
  const bucket = buckets.get(rule.key);
  if (!bucket) {
    return {
      expiresAt: now + rule.windowMs,
      lastSeenAt: now,
      tokens: rule.limit,
      updatedAt: now,
    };
  }

  const refill = ((now - bucket.updatedAt) * rule.limit) / rule.windowMs;
  bucket.tokens = Math.min(rule.limit, bucket.tokens + Math.max(0, refill));
  bucket.updatedAt = now;
  bucket.lastSeenAt = now;
  bucket.expiresAt = now + rule.windowMs;
  return bucket;
}

function cleanupBuckets(now: number): void {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }

  lastCleanupAt = now;
  for (const [key, bucket] of buckets) {
    if (bucket.expiresAt <= now) {
      buckets.delete(key);
    }
  }
  trimBuckets();
}

function trimBuckets(): void {
  if (buckets.size <= MAX_BUCKETS) {
    return;
  }

  const overflow = buckets.size - MAX_BUCKETS;
  const staleKeys = [...buckets.entries()]
    .sort(([, left], [, right]) => left.expiresAt - right.expiresAt || left.lastSeenAt - right.lastSeenAt)
    .slice(0, overflow)
    .map(([key]) => key);

  for (const key of staleKeys) {
    buckets.delete(key);
  }
}

function withRateLimitHeaders(response: NextResponse, limit: RateLimitDecision): NextResponse {
  response.headers.set("X-RateLimit-Limit", String(limit.limit));
  response.headers.set("X-RateLimit-Reset", String(Math.ceil(limit.resetAt / 1000)));

  if (limit.allowed) {
    response.headers.set("X-RateLimit-Remaining", String(limit.remaining));
  } else {
    response.headers.set("X-RateLimit-Remaining", "0");
    response.headers.set("Retry-After", String(limit.retryAfter));
  }

  return response;
}

export function resetProxyRateLimitsForTest() {
  buckets.clear();
  lastCleanupAt = 0;
}

export const config = {
  matcher: [
    "/api/douyin/:path*",
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|echolens-logo.svg).*)",
  ],
};
