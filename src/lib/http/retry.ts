import { ProxyAgent, type Dispatcher } from "undici";

export type RetryableFetchInit = RequestInit & {
  duplex?: "half";
  retry?: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    timeoutMs?: number;
  };
};

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5_000;
const proxyAgents = new Map<string, Dispatcher>();

export async function fetchWithRetry(
  url: string,
  init: RetryableFetchInit = {},
): Promise<Response> {
  const attempts = readPositiveInteger(init.retry?.attempts, DEFAULT_ATTEMPTS);
  const baseDelayMs = readPositiveInteger(init.retry?.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = readPositiveInteger(init.retry?.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  const timeoutMs = init.retry?.timeoutMs;
  const { signal: externalSignal, ...requestInit } = withoutRetry(init);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchOnce(url, requestInit, timeoutMs, externalSignal);
      if (!isRetryableStatus(response.status) || attempt === attempts) {
        return response;
      }

      await response.body?.cancel();
      await delay(readRetryDelay(response, attempt, baseDelayMs, maxDelayMs));
    } catch (error) {
      lastError = error;
      if (!isRetryableFetchError(error) || attempt === attempts) {
        throw error;
      }

      await delay(exponentialDelay(attempt, baseDelayMs, maxDelayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("网络请求失败。");
}

function withoutRetry(init: RetryableFetchInit): RequestInit & { duplex?: "half" } {
  const { retry: _retry, ...requestInit } = init;
  void _retry;
  return requestInit;
}

function fetchOnce(
  url: string,
  init: RequestInit & { duplex?: "half" },
  timeoutMs: number | undefined,
  externalSignal: AbortSignal | null | undefined,
): Promise<Response> {
  const dispatcher = readProxyDispatcher();
  const requestInit = {
    ...init,
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit & { dispatcher?: Dispatcher; duplex?: "half" };

  if (!timeoutMs) {
    return fetch(url, { ...requestInit, signal: externalSignal ?? undefined });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortExternal = () => controller.abort();
  externalSignal?.addEventListener("abort", abortExternal, { once: true });

  return fetch(url, {
    ...requestInit,
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortExternal);
  });
}

function readProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = process.env.SERVER_HTTP_PROXY?.trim();
  if (!proxyUrl) {
    return undefined;
  }

  const existing = proxyAgents.get(proxyUrl);
  if (existing) {
    return existing;
  }

  const agent = new ProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, agent);
  return agent;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }

  return error.name === "AbortError" ||
    /fetch failed|network|socket|timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/i.test(error.message);
}

function readRetryDelay(response: Response, attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, maxDelayMs);
  }

  return exponentialDelay(attempt, baseDelayMs, maxDelayMs);
}

function exponentialDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * Math.min(baseDelayMs, 250));
  return Math.min(exponential + jitter, maxDelayMs);
}

function readPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
