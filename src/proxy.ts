import { NextRequest, NextResponse } from "next/server";

const AGENT_USER_AGENT =
  /\b(GPTBot|ChatGPT-User|ClaudeBot|Claude-Web|anthropic-ai|PerplexityBot|Perplexity-User|CCBot|Bytespider|Amazonbot|Applebot-Extended|Google-Extended|meta-externalagent|OAI-SearchBot|cohere-ai|Diffbot|YouBot|ImagesiftBot)\b/i;

export function proxy(request: NextRequest) {
  const userAgent = request.headers.get("user-agent") ?? "";
  if (AGENT_USER_AGENT.test(userAgent)) {
    return new NextResponse("Forbidden", {
      status: 403,
      headers: { "X-Robots-Tag": "noindex, nofollow, noarchive, noai, noimageai" },
    });
  }

  if (request.nextUrl.pathname.startsWith("/api/douyin/") && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.next();
}

function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  return (
    (!origin || origin === request.nextUrl.origin) &&
    (!referer || readOrigin(referer) === request.nextUrl.origin)
  );
}

function readOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|echolens-logo.svg|robots.txt).*)"],
};
