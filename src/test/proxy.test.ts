import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import { createSessionCookieValue, SESSION_COOKIE } from "@/lib/auth/session-cookie";

const AUTH_COOKIE = `${SESSION_COOKIE}=${createSessionCookieValue("test-session-token-00000000000000000000", Date.now() + 60_000)}`;

describe("proxy auth gate", () => {
  it("does not reject page requests by user agent", () => {
    const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/", {
      headers: {
        "user-agent": "ChatGPT-User",
      },
    }));

    expect(response.status).not.toBe(403);
  });

  it("does not issue anonymous client cookies on page requests", () => {
    const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/login", {
      headers: {
        accept: "text/html",
      },
    }));

    expect(response.cookies.getAll()).toHaveLength(0);
  });

  it("allows unauthenticated home requests", () => {
    const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/"));

    expect(response.status).not.toBe(307);
  });

  it("allows public legal requests without a session", () => {
    const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/legal"));

    expect(response.status).not.toBe(307);
    expect(response.status).not.toBe(401);
  });

  it("keeps auth pages public even when a session cookie exists", () => {
    const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/login", {
      headers: {
        cookie: AUTH_COOKIE,
      },
    }));

    expect(response.status).not.toBe(307);
    expect(response.status).not.toBe(401);
  });

  it("allows authenticated API requests without anonymous client cookies", () => {
    const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/api/douyin/resolve", {
      headers: {
        cookie: AUTH_COOKIE,
        "user-agent": "Mozilla/5.0",
      },
    }));

    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(401);
    expect(response.cookies.getAll()).toHaveLength(0);
  });

  it("rejects unauthenticated API requests before the rate limit", async () => {
    const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/api/douyin/resolve", {
      headers: {
        origin: "https://example.com",
        referer: "https://example.com/",
        "user-agent": "curl/8.5.0",
      },
    }));

    expect(response.status).not.toBe(403);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

});
