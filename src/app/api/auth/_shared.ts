import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, readCurrentUserFromRequest, type AuthUser } from "@/lib/auth/service";

export const EmailSchema = z.string().trim().email().max(254);
export const PasswordSchema = z.string().min(1).max(128);
export const CodeSchema = z.string().regex(/^\d{6}$/);

export function authJson(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function errorJson(error: unknown): NextResponse {
  if (error instanceof AuthError) {
    return authJson({ code: error.code, error: error.message }, { status: error.status });
  }

  return authJson(
    {
      code: "INTERNAL_ERROR",
      error: error instanceof Error ? error.message : "请求处理失败。",
    },
    { status: 500 },
  );
}

export async function requireUser(request: Request): Promise<AuthUser | NextResponse> {
  const user = await readCurrentUserFromRequest(request);
  return user ?? unauthenticatedJson();
}

export function unauthenticatedJson(): NextResponse {
  return authJson({ code: "UNAUTHENTICATED", error: "请先登录后再使用。" }, { status: 401 });
}
