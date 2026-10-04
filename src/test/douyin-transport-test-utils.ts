import { vi } from "vitest";

// Keep collection tests at the transport boundary; SDK behavior has its own tests.
vi.mock("@/lib/douyin/page-bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/douyin/page-bridge")>(),
  requestDouyinPage: async (input: {
    cookie: string; path: string; params: Record<string, string | number>;
    body?: Record<string, string | number>; method?: string; signal?: AbortSignal;
    beforeDispatch?: () => Promise<void>;
  }) => {
    await input.beforeDispatch?.();
    const url = new URL(input.path, "https://www.douyin.com");
    for (const [key, value] of Object.entries(input.params)) url.searchParams.set(key, String(value));
    return fetch(url.toString(), {
      method: input.method ?? "GET", signal: input.signal,
      headers: { cookie: input.cookie },
      body: input.body ? new URLSearchParams(Object.entries(input.body).map(([key, value]) => [key, String(value)])).toString() : undefined,
    });
  },
}));
vi.mock("@/lib/open-api/platform-request-policy", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/open-api/platform-request-policy")>(),
  openApiPlatformRequestPolicy: { forUser: () => ({
    beforeRequest: vi.fn(), observeResponse: vi.fn(), observePayload: vi.fn(),
  }) },
}));
