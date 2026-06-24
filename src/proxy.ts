import { NextRequest, NextResponse } from "next/server";
import { readSessionCookieValue, SESSION_COOKIE } from "@/lib/auth/session-cookie";

export function proxy(request: NextRequest) {
  if (!isDouyinApiRequest(request)) {
    return NextResponse.next();
  }

  if (!hasSignedSession(request)) {
    return NextResponse.json({ error: "请先登录后再使用。", code: "UNAUTHENTICATED" }, { status: 401 });
  }

  return NextResponse.next();
}

function isDouyinApiRequest(request: NextRequest): boolean {
  return request.nextUrl.pathname.startsWith("/api/douyin/");
}

function hasSignedSession(request: NextRequest): boolean {
  return Boolean(readSessionCookieValue(request.cookies.get(SESSION_COOKIE)?.value));
}

export const config = {
  matcher: ["/api/douyin/:path*"],
};
