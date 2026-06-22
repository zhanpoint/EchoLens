import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy, resetProxyRateLimitsForTest } from "../proxy";

describe("proxy rate limits", () => {
  beforeEach(() => {
    resetProxyRateLimitsForTest();
  });

  it("does not reject page requests by user agent", () => {
    const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/", {
      headers: {
        "user-agent": "ChatGPT-User",
      },
    }));

    expect(response.status).not.toBe(403);
  });

  it("issues a first-party client cookie on page requests", () => {
    const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/", {
      headers: {
        accept: "text/html",
      },
    }));

    expect(response.cookies.get("el_client")?.value).toBeTruthy();
  });

  it("issues a client cookie on allowed API requests", () => {
    const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/api/douyin/resolve", {
      headers: {
        "user-agent": "Mozilla/5.0",
      },
    }));

    expect(response.status).not.toBe(403);
    expect(response.cookies.get("el_client")?.value).toBeTruthy();
  });

  it("does not block API requests by origin or user agent before the rate limit", () => {
    const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/api/douyin/resolve", {
      headers: {
        origin: "https://example.com",
        referer: "https://example.com/",
        "user-agent": "curl/8.5.0",
      },
    }));

    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(429);
  });

  it("rate limits frequent requests from the same browser identity", () => {
    const headers = {
      cookie: "el_client=test-client-000000000000",
      origin: "https://echolens.dreamlog.xyz",
      referer: "https://echolens.dreamlog.xyz/",
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "203.0.113.10",
    };

    for (let index = 0; index < 20; index += 1) {
      const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/api/douyin/resolve", { headers }));
      expect(response.status).not.toBe(429);
    }

    const blocked = proxy(new NextRequest("https://echolens.dreamlog.xyz/api/douyin/resolve", { headers }));

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(blocked.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  it("rate limits repeated API requests that do not keep the client cookie", async () => {
    const headers = {
      "accept-language": "zh-CN",
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "203.0.113.20",
    };

    for (let index = 0; index < 6; index += 1) {
      const response = proxy(new NextRequest("https://echolens.dreamlog.xyz/api/douyin/resolve", { headers }));
      expect(response.status).not.toBe(429);
    }

    const blocked = proxy(new NextRequest("https://echolens.dreamlog.xyz/api/douyin/resolve", { headers }));

    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      code: "RATE_LIMITED",
      error: expect.stringContaining("请求太频繁"),
    });
  });
});
