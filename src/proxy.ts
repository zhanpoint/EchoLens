import { NextRequest, NextResponse } from "next/server";
import { readSessionCookieValue, SESSION_COOKIE } from "@/lib/auth/session-cookie";

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isDouyinApiRequest = pathname.startsWith("/api/douyin/");
  const isDouyinPageRequest = pathname.startsWith("/douyin/");

  if ((!isDouyinApiRequest && !isDouyinPageRequest) || hasSignedSession(request)) {
    return NextResponse.next();
  }

  if (isDouyinApiRequest) {
    return NextResponse.json({ error: "请先登录后再使用。", code: "UNAUTHENTICATED" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

function hasSignedSession(request: NextRequest): boolean {
  return Boolean(readSessionCookieValue(request.cookies.get(SESSION_COOKIE)?.value));
}

export const config = {
  matcher: ["/douyin/:path*", "/api/douyin/:path*"],
};
