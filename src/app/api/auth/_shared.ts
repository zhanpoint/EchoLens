import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, readCurrentUserFromRequest, type AuthUser } from "@/lib/auth/service";
import { readUserFromApiAccessToken } from "@/lib/api-access-tokens/service";
import { AuthRateLimitError } from "@/lib/auth/rate-limit";

export const EmailSchema = z.string().trim().email().max(254);
export const PasswordSchema = z.string().min(1).max(128);
export const CodeSchema = z.string().regex(/^\d{6}$/);

export function authJson(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function errorJson(error: unknown): NextResponse {
  if (error instanceof AuthError || error instanceof AuthRateLimitError) {
    return authJson({ code: error.code, error: error.message }, { status: error.status });
  }

  return authJson(
    {
      code: "INTERNAL_ERROR",
      error: "请求处理失败。",
    },
    { status: 500 },
  );
}

export async function requireUser(request: Request): Promise<AuthUser | NextResponse> {
  const bearerUser = await readUserFromApiAccessToken(readBearerToken(request));
  if (bearerUser) return bearerUser;
  const user = await readCurrentUserFromRequest(request);
  return user ?? unauthenticatedJson();
}

function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function unauthenticatedJson(): NextResponse {
  return authJson({ code: "UNAUTHENTICATED", error: "请先登录后再使用。" }, { status: 401 });
}

export function logServerError(scope: string, error: unknown): void {
  console.error(`[${scope}]`, error);
}
