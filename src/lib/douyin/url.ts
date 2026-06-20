import type { DouyinKind, ResolvedDouyinWork } from "@/types/douyin";

const URL_PATTERN = /https?:\/\/[^\s"'<>，。！？；、）】》\\]+/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 8;

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

  return match[0].replace(/[)\]}.,!?;，。！？；、]+$/u, "");
}

export function classifyDouyinUrl(value: string): Pick<
  ResolvedDouyinWork,
  "finalUrl" | "kind" | "id"
> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DouyinResolveError("这个链接格式不太对，请检查后再试。", "invalid_url");
  }

  if (!isDouyinHost(url.hostname)) {
    throw new DouyinResolveError("目前只支持抖音作品链接。", "unsupported_host");
  }

  const [, rawKind, id] = url.pathname.split("/");
  if (!id || !isDouyinKind(rawKind)) {
    throw new DouyinResolveError("请粘贴抖音视频、图文或文章作品链接。", "unsupported_type");
  }

  return {
    finalUrl: `${url.origin}/${rawKind}/${id}`,
    kind: rawKind,
    id,
  };
}

export async function resolveDouyinInput(input: string): Promise<ResolvedDouyinWork> {
  const inputUrl = extractFirstUrl(input);
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
  ResolvedDouyinWork,
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

async function followRedirects(inputUrl: string): Promise<string> {
  let current = inputUrl;

  for (let i = 0; i < MAX_REDIRECTS; i += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: requestHeaders(),
    }).catch((error: unknown) => {
      throw new DouyinResolveError(
        error instanceof Error ? error.message : "追踪重定向失败。",
        "network_error",
      );
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response.url || current;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response.url || current;
    }

    current = new URL(location, current).toString();
  }

  throw new DouyinResolveError("重定向次数过多。", "too_many_redirects");
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

function isDouyinHost(hostname: string): boolean {
  return hostname === "douyin.com" || hostname.endsWith(".douyin.com");
}

function isDouyinKind(value: string | undefined): value is DouyinKind {
  return value === "video" || value === "note" || value === "article";
}
