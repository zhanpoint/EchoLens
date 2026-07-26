import { createHash } from "node:crypto";
import { clearAuthRateLimit, consumeAuthRateLimit } from "@/lib/auth/db";

export class AuthRateLimitError extends Error {
  readonly code = "AUTH_RATE_LIMITED";
  readonly status = 429;
}

export type AuthRateLimit = {
  limit: number;
  scope: string;
  subject: string;
  windowSeconds: number;
};

export async function enforceAuthRateLimits(limits: readonly AuthRateLimit[]): Promise<void> {
  for (const limit of limits) {
    const result = await consumeAuthRateLimit({
      ...limit,
      subjectHash: hashSubject(limit.subject),
    });
    if (!result.allowed) {
      throw new AuthRateLimitError(`请求过于频繁，请 ${result.retryAfterSeconds} 秒后重试。`);
    }
  }
}

export async function clearAuthIdentityRateLimit(scope: string, subject: string): Promise<void> {
  await clearAuthRateLimit(scope, hashSubject(subject));
}

export function readClientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded?.at(-1) ?? request.headers.get("x-real-ip")?.trim() ?? "unknown";
}

function hashSubject(subject: string): string {
  return createHash("sha256").update(subject.trim().toLowerCase()).digest("hex");
}
