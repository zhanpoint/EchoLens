import type { DouyinKind, DouyinWorkIdentity } from "@/types/douyin";
import { fetchWithRetry } from "@/lib/http/retry";

const URL_PATTERN = /https?:\/\/[^\s"'<>，。！？；、）】》\\]+/i;
const TRAILING_URL_PUNCTUATION_PATTERN = /[)\]}.,!?;:，。！？；：、]+$/u;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const CANONICAL_DOUYIN_ORIGIN = "https://www.douyin.com";
const NETWORK_ERROR_MESSAGE = "网络连接失败，请检查网络后重试。";

export class DouyinResolveError extends Error {
  constructor(
    message: string,
    readonly code:
      | "no_url"
      | "invalid_url"
      | "unsupported_host"
      | "unsupported_type"
      | "too_many_redirects"
      | "network_error",
  ) {
    super(message);
  }
}

export function extractFirstUrl(input: string): string {
  const match = input.match(URL_PATTERN);
  if (!match) {
    throw new DouyinResolveError("还没有识别到有效链接，请粘贴完整的抖音作品分享链接。", "no_url");
  }

  return match[0].replace(TRAILING_URL_PUNCTUATION_PATTERN, "");
}

export function classifyDouyinUrl(value: string): Pick<
  DouyinWorkIdentity,
  "finalUrl" | "kind" | "id"
> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DouyinResolveError("这个链接格式不太对，请检查后再试。", "invalid_url");
  }

  const work = classifyCanonicalWorkUrl(url) ?? classifyShareWorkUrl(url);
  if (work) {
    return work;
  }

  if (!isSupportedDouyinHost(url.hostname)) {
    throw new DouyinResolveError("目前只支持抖音作品链接。", "unsupported_host");
  }

  throw new DouyinResolveError("请粘贴抖音视频作品链接。", "unsupported_type");
}

export async function resolveDouyinInput(input: string): Promise<DouyinWorkIdentity> {
  return resolveDouyinUrl(extractFirstUrl(input));
}

export async function resolveDouyinUrl(inputUrl: string): Promise<DouyinWorkIdentity> {
  const directWork = classifyDirectWorkUrl(inputUrl);
  if (directWork) {
    return {
      inputUrl,
      ...directWork,
    };
  }

  const finalUrl = await followRedirects(inputUrl);
  const classified = classifyDouyinUrl(finalUrl);

  return {
    inputUrl,
    ...classified,
  };
}

function classifyDirectWorkUrl(inputUrl: string): Pick<
  DouyinWorkIdentity,
  "finalUrl" | "kind" | "id"
> | null {
  try {
    return classifyDouyinUrl(inputUrl);
  } catch (error) {
    if (error instanceof DouyinResolveError && error.code === "unsupported_type" && isShortDouyinUrl(inputUrl)) {
      return null;
    }
    throw error;
  }
}

function classifySupportedWorkUrl(value: string): Pick<
  DouyinWorkIdentity,
  "finalUrl" | "kind" | "id"
> | null {
  const url = new URL(value);
  return classifyCanonicalWorkUrl(url) ?? classifyShareWorkUrl(url);
}

async function followRedirects(inputUrl: string): Promise<string> {
  let current = inputUrl;
  let redirectCount = 0;

  while (true) {
    const work = classifySupportedWorkUrl(current);
    if (work) {
      return work.finalUrl;
    }
    if (redirectCount >= MAX_REDIRECTS) {
      throw new DouyinResolveError("重定向次数过多。", "too_many_redirects");
    }

    const response = await fetchWithRetry(current, {
      method: "GET",
      redirect: "manual",
      headers: requestHeaders(),
      retry: {
        attempts: 5,
        baseDelayMs: 500,
        maxDelayMs: 4_000,
        timeoutMs: 12_000,
      },
    }).catch(() => {
      throw new DouyinResolveError(NETWORK_ERROR_MESSAGE, "network_error");
    });

    if (response.status === 429 || response.status >= 500) {
      throw new DouyinResolveError(NETWORK_ERROR_MESSAGE, "network_error");
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response.url || current;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response.url || current;
    }

    current = new URL(location, current).toString();
    redirectCount += 1;
  }
}

function isShortDouyinUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "v.douyin.com";
  } catch {
    return false;
  }
}

function requestHeaders(): HeadersInit {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  };
}

function classifyCanonicalWorkUrl(url: URL): Pick<
  DouyinWorkIdentity,
  "finalUrl" | "kind" | "id"
> | null {
  if (!isDouyinHost(url.hostname)) {
    return null;
  }

  const [rawKind, id] = pathSegments(url);
  if (!id || !isDouyinKind(rawKind)) {
    return null;
  }

  return buildCanonicalWork(rawKind, id);
}

function classifyShareWorkUrl(url: URL): Pick<
  DouyinWorkIdentity,
  "finalUrl" | "kind" | "id"
> | null {
  if (!isIesDouyinHost(url.hostname)) {
    return null;
  }

  const [share, rawKind, id] = pathSegments(url);
  if (share !== "share" || !id || !isDouyinKind(rawKind)) {
    return null;
  }

  return buildCanonicalWork(rawKind, id);
}

function buildCanonicalWork(kind: DouyinKind, id: string): Pick<
  DouyinWorkIdentity,
  "finalUrl" | "kind" | "id"
> {
  return {
    finalUrl: `${CANONICAL_DOUYIN_ORIGIN}/${kind}/${id}`,
    kind,
    id,
  };
}

function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

function isSupportedDouyinHost(hostname: string): boolean {
  return isDouyinHost(hostname) || isIesDouyinHost(hostname);
}

function isDouyinHost(hostname: string): boolean {
  return hostname === "douyin.com" || hostname.endsWith(".douyin.com");
}

function isIesDouyinHost(hostname: string): boolean {
  return hostname === "iesdouyin.com" || hostname === "www.iesdouyin.com";
}

function isDouyinKind(value: string | undefined): value is DouyinKind {
  return value === "video";
}
