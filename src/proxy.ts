import { NextRequest, NextResponse } from "next/server";

const CLIENT_COOKIE = "el_client";
const CLIENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
const CLEANUP_INTERVAL_MS = 60_000;
// 1GB single-instance hosts should keep middleware state comfortably below app/runtime memory.
const MAX_BUCKETS = 4_096;

type ApiRouteKind = "download" | "expensive" | "resolve";

type LimitRule = {
  key: string;
  limit: number;
  windowMs: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

type RateLimitDecision =
  | { allowed: true; limit: number; remaining: number; resetAt: number }
  | { allowed: false; limit: number; retryAfter: number; resetAt: number };

const buckets = new Map<string, Bucket>();
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

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

function readClientIdentity(request: NextRequest): { id: string; isNew: boolean } {
  const cookieId = normalizeClientId(request.cookies.get(CLIENT_COOKIE)?.value);
  if (cookieId) {
    return { id: cookieId, isNew: false };
  }

  return { id: createClientId(), isNew: true };
}

function normalizeClientId(value: string | undefined): string | null {
  return value && /^[a-z0-9_-]{20,80}$/iu.test(value) ? value : null;
}

function createClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function withClientCookie(
  response: NextResponse,
  request: NextRequest,
  client: { id: string; isNew: boolean },
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
  client: { id: string; isNew: boolean },
): RateLimitDecision {
  const now = Date.now();
  cleanupBuckets(now);

  const rules = buildLimitRules(request, client);
  const blocked = rules
    .map((rule) => ({ rule, bucket: readBucket(rule, now) }))
    .find(({ rule, bucket }) => bucket.count >= rule.limit);

  if (blocked) {
    return {
      allowed: false,
      limit: blocked.rule.limit,
      resetAt: blocked.bucket.resetAt,
      retryAfter: Math.max(1, Math.ceil((blocked.bucket.resetAt - now) / 1000)),
    };
  }

  const snapshots = rules.map((rule) => {
    const bucket = readBucket(rule, now);
    bucket.count += 1;
    buckets.set(rule.key, bucket);
    return { rule, bucket };
  });
  trimBuckets();

  const tightest = snapshots.reduce((current, next) => {
    const currentRemaining = current.rule.limit - current.bucket.count;
    const nextRemaining = next.rule.limit - next.bucket.count;
    return nextRemaining < currentRemaining ? next : current;
  });

  return {
    allowed: true,
    limit: tightest.rule.limit,
    remaining: Math.max(0, tightest.rule.limit - tightest.bucket.count),
    resetAt: tightest.bucket.resetAt,
  };
}

function buildLimitRules(
  request: NextRequest,
  client: { id: string; isNew: boolean },
): LimitRule[] {
  const routeKind = readApiRouteKind(request.nextUrl.pathname);
  const ip = readClientIp(request);
  const identity = stableHash(
    client.isNew
      ? [
          "anon",
          ip,
          request.headers.get("user-agent") ?? "",
          request.headers.get("accept-language") ?? "",
        ].join("|")
      : `client|${client.id}`,
  );
  const ipHash = stableHash(ip);
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

function readClientIp(request: NextRequest): string {
  return (
    firstHeaderValue(request.headers.get("cf-connecting-ip")) ??
    firstHeaderValue(request.headers.get("x-real-ip")) ??
    firstHeaderValue(request.headers.get("x-forwarded-for")) ??
    readForwardedFor(request.headers.get("forwarded")) ??
    "unknown"
  );
}

function readForwardedFor(value: string | null): string | null {
  const first = firstHeaderValue(value);
  const forwardedFor = first?.match(/(?:^|;)\s*for=(?:"?)([^";,]+)(?:"?)/iu)?.[1];
  return forwardedFor?.trim() || null;
}

function readBucket(rule: LimitRule, now: number): Bucket {
  const bucket = buckets.get(rule.key);
  if (!bucket || bucket.resetAt <= now) {
    return { count: 0, resetAt: now + rule.windowMs };
  }

  return bucket;
}

function cleanupBuckets(now: number): void {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }

  lastCleanupAt = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
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
  let deleted = 0;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    deleted += 1;
    if (deleted >= overflow) {
      break;
    }
  }
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36);
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
