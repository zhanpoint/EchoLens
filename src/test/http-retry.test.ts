import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithRetry,
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
  retryOperation,
} from "@/lib/http/retry";

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries network failures with exponential backoff", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const task = fetchWithRetry("https://example.com", {
      retry: { attempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
    });
    await vi.advanceTimersByTimeAsync(10);

    await expect(task).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses five total attempts and returns the unified exhausted error", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));

    const task = fetchWithRetry("https://example.com");
    const rejection = expect(task).rejects.toMatchObject({
      code: NETWORK_RETRY_ERROR_CODE,
      message: NETWORK_RETRY_ERROR_MESSAGE,
      name: NetworkRetryExhaustedError.name,
    });
    await vi.runAllTimersAsync();

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("retries operations with 0.5s, 1s, 2s, and 4s delays", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const operation = vi.fn().mockRejectedValue(new Error("socket timeout"));

    const task = retryOperation(operation);
    const rejection = expect(task).rejects.toBeInstanceOf(NetworkRetryExhaustedError);
    await vi.advanceTimersByTimeAsync(499);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(operation).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(operation).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(4_000);

    await rejection;
    expect(operation).toHaveBeenCalledTimes(5);
  });

  it("does not retry non-Error business failures", async () => {
    const operation = vi.fn().mockRejectedValue({ code: "BUSINESS_REJECTED" });

    await expect(retryOperation(operation)).rejects.toEqual({ code: "BUSINESS_REJECTED" });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry an externally aborted request", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Aborted", "AbortError"));
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(fetchWithRetry("https://example.com", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps caller cancellation connected after response headers arrive", async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      return new Response(new ReadableStream({
        start(stream) {
          init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), { once: true });
        },
      }));
    });
    const response = await fetchWithRetry("https://example.com", {
      signal: controller.signal,
      retry: { timeoutMs: 10_000 },
    });
    const text = response.text();
    controller.abort(new Error("caller canceled"));
    await expect(text).rejects.toThrow("caller canceled");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("can retry explicit HTTP failures without replaying transport failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));

    await expect(fetchWithRetry("https://example.com", {
      method: "POST",
      retry: { retryNetworkErrors: false },
    })).rejects.toThrow("fetch failed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("enforces the deadline while a response body stalls after receiving headers", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(stream) {
        init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), { once: true });
      },
    })));
    const response = await fetchWithRetry("https://example.com", { retry: { timeoutMs: 20 } });
    await expect(response.text()).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("honors Retry-After values longer than the local backoff cap", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "retry-after": "30" } }))
      .mockResolvedValueOnce(new Response("ok"));
    const task = fetchWithRetry("https://example.com");
    await vi.advanceTimersByTimeAsync(29999);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(task).resolves.toMatchObject({ status: 200 });
  });

  it("uses Retry-After for 429 responses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("limited", { headers: { "retry-after": "2" }, status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const task = fetchWithRetry("https://example.com", { retry: { attempts: 2 } });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(task).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("can limit retries to network errors, 429, and 5xx", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("timeout", { status: 408 }));

    const response = await fetchWithRetry("https://example.com", {
      retry: { retryHttpStatuses: [429], retryOnDefaultHttpStatuses: false },
    });

    expect(response.status).toBe(408);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries server errors but not client errors", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("temporary", { status: 502 }))
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));

    const task = fetchWithRetry("https://example.com", {
      retry: { attempts: 3, baseDelayMs: 10, maxDelayMs: 10 },
    });
    await vi.advanceTimersByTimeAsync(10);

    await expect(task).resolves.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
