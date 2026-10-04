export const NETWORK_RETRY_ERROR_CODE = "NETWORK_RETRY_EXHAUSTED";
export const NETWORK_RETRY_ERROR_MESSAGE = "网络连接失败，请检查网络后重试。";
export const DEFAULT_NETWORK_ATTEMPTS = 5;

export class NetworkRetryExhaustedError extends Error {
  readonly code = NETWORK_RETRY_ERROR_CODE;

  constructor(options?: ErrorOptions) {
    super(NETWORK_RETRY_ERROR_MESSAGE, options);
    this.name = "NetworkRetryExhaustedError";
  }
}

export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown) => boolean;
};

export type RetryableFetchInit = RequestInit & {
  duplex?: "half";
  retry?: Omit<RetryOptions, "signal" | "shouldRetry"> & {
    retryNetworkErrors?: boolean;
    timeoutMs?: number;
    retryHttpStatuses?: number[];
    retryOnDefaultHttpStatuses?: boolean;
    onResponse?: (response: Response) => void | Promise<void>;
  };
};

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);

export async function retryOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = readPositiveInteger(options.attempts, DEFAULT_NETWORK_ATTEMPTS);
  const baseDelayMs = readPositiveInteger(options.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = readPositiveInteger(options.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  const shouldRetry = options.shouldRetry ?? isRetryableNetworkError;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfExternallyAborted(options.signal);
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || !shouldRetry(error)) throw error;
      if (attempt < attempts) {
        await abortableDelay(exponentialRetryDelay(attempt, baseDelayMs, maxDelayMs), options.signal);
      }
    }
  }

  throw new NetworkRetryExhaustedError({ cause: lastError });
}

export async function fetchWithRetry(
  url: string,
  init: RetryableFetchInit = {},
): Promise<Response> {
  const attempts = readPositiveInteger(init.retry?.attempts, DEFAULT_NETWORK_ATTEMPTS);
  const baseDelayMs = readPositiveInteger(init.retry?.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = readPositiveInteger(init.retry?.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  const timeoutMs = init.retry?.timeoutMs;
  const retryHttpStatuses = new Set(init.retry?.retryHttpStatuses ?? []);
  const { signal: externalSignal, ...requestInit } = withoutRetry(init);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfExternallyAborted(externalSignal);
    try {
      const response = await fetchOnce(url, requestInit, timeoutMs, externalSignal);
      try {
        await init.retry?.onResponse?.(response);
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      if (!isRetryableHttpStatus(response.status, retryHttpStatuses, init.retry?.retryOnDefaultHttpStatuses !== false) || attempt === attempts) return response;

      await response.body?.cancel();
      await abortableDelay(readRetryDelay(response, attempt, baseDelayMs, maxDelayMs), externalSignal);
    } catch (error) {
      lastError = error;
      if (externalSignal?.aborted || init.retry?.retryNetworkErrors === false || !isRetryableNetworkError(error)) throw error;
      if (attempt < attempts) {
        await abortableDelay(exponentialRetryDelay(attempt, baseDelayMs, maxDelayMs), externalSignal);
      }
    }
  }

  throw new NetworkRetryExhaustedError({ cause: lastError });
}

export function isRetryableHttpStatus(
  status: number,
  extraStatuses: ReadonlySet<number> = new Set(),
  includeDefaultStatuses = true,
): boolean {
  return extraStatuses.has(status) || (includeDefaultStatuses && RETRYABLE_HTTP_STATUSES.has(status)) || status >= 500;
}

export function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof NetworkRetryExhaustedError) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" ||
    /fetch failed|network|socket|timeout|timed out|terminated|premature close|other side closed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR/i.test(error.message) ||
    /HTTP (408|425|429|5\d\d)\b/i.test(error.message);
}

export function exponentialRetryDelay(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(Math.round(exponential * jitter), maxDelayMs);
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
  if (!timeoutMs) return fetch(url, { ...init, signal: externalSignal ?? undefined });

  // Keep the deadline active while the response body (including SSE) is consumed.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([timeoutSignal, externalSignal])
    : timeoutSignal;
  return fetch(url, { ...init, signal });
}

function readRetryDelay(response: Response, attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
  const retryAfterMs = Number.isFinite(retryAfterSeconds)
    ? retryAfterSeconds * 1000
    : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
  if (retryAfterMs > 0) return retryAfterMs;
  return exponentialRetryDelay(attempt, baseDelayMs, maxDelayMs);
}

function throwIfExternallyAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function readPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

async function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
