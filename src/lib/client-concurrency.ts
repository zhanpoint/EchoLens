import { NextResponse } from "next/server";
import { readClientIdentityFromHeaders } from "@/lib/request-identity";

const LOCK_TTL_MS = 150_000;
const MAX_LOCKS = 1_024;

type Lock = {
  expiresAt: number;
  lastSeenAt: number;
};

const locks = new Map<string, Lock>();

export async function withClientRouteConcurrency(
  request: Request,
  route: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  const now = Date.now();
  cleanupLocks(now);

  const key = `${route}:${readClientIdentityFromHeaders(request.headers)}`;
  const existing = locks.get(key);
  if (existing && existing.expiresAt > now) {
    existing.lastSeenAt = now;
    return NextResponse.json(
      {
        error: "当前操作仍在处理中，请完成后再试。",
        code: "REQUEST_IN_PROGRESS",
      },
      {
        status: 429,
        headers: { "Retry-After": "3" },
      },
    );
  }

  locks.set(key, { expiresAt: now + LOCK_TTL_MS, lastSeenAt: now });
  trimLocks();

  try {
    return await handler();
  } finally {
    locks.delete(key);
  }
}

function cleanupLocks(now: number): void {
  for (const [key, lock] of locks) {
    if (lock.expiresAt <= now) {
      locks.delete(key);
    }
  }
  trimLocks();
}

function trimLocks(): void {
  if (locks.size <= MAX_LOCKS) {
    return;
  }

  const overflow = locks.size - MAX_LOCKS;
  const staleKeys = [...locks.entries()]
    .sort(([, left], [, right]) => left.expiresAt - right.expiresAt || left.lastSeenAt - right.lastSeenAt)
    .slice(0, overflow)
    .map(([key]) => key);

  for (const key of staleKeys) {
    locks.delete(key);
  }
}

export function resetClientRouteConcurrencyForTest(): void {
  locks.clear();
}
