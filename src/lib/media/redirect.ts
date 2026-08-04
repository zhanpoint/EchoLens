import {
  extractHttpUrl,
  mediaSourceFromUrl,
  parseHttpUrl,
  type MediaSource,
} from "@/lib/media/source";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_TIMEOUT_MS = 12_000;
const INVALID_LINK_MESSAGE = "请重新输入带 http:// 或 https:// 的正确视频分享链接。";
const NETWORK_ERROR_MESSAGE = "网络连接失败，请检查网络后重试。";
const REQUEST_HEADERS: HeadersInit = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

export type ResolvedMediaUrl = {
  finalUrl: string;
  inputUrl: string;
  source: MediaSource;
};

export class MediaRedirectError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_url" | "unsupported_source" | "network_error",
  ) {
    super(message);
    this.name = "MediaRedirectError";
  }
}

export function extractFirstUrl(input: string): string {
  const extracted = extractHttpUrl(input);
  if (!extracted) {
    throw new MediaRedirectError(INVALID_LINK_MESSAGE, "invalid_url");
  }
  return extracted.value;
}

export async function resolveMediaUrl(input: string): Promise<ResolvedMediaUrl> {
  const inputUrl = extractFirstUrl(input);
  const finalUrl = await followRedirectOnce(inputUrl);
  const source = mediaSourceFromUrl(finalUrl);
  if (!source) {
    throw new MediaRedirectError(
      "暂不支持该链接来源，请粘贴抖音或 Bilibili 作品链接。",
      "unsupported_source",
    );
  }
  return { finalUrl, inputUrl, source };
}

async function followRedirectOnce(inputUrl: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(inputUrl, {
      cache: "no-store",
      headers: REQUEST_HEADERS,
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new MediaRedirectError(NETWORK_ERROR_MESSAGE, "network_error");
  }

  const location = response.headers.get("location");
  const responseUrl = response.url || inputUrl;
  await response.body?.cancel();

  if (response.status === 429 || response.status >= 500) {
    throw new MediaRedirectError(NETWORK_ERROR_MESSAGE, "network_error");
  }
  if (!REDIRECT_STATUSES.has(response.status) || !location) {
    return responseUrl;
  }

  const finalUrl = parseHttpUrl(location, inputUrl);
  if (!finalUrl) {
    throw new MediaRedirectError(INVALID_LINK_MESSAGE, "invalid_url");
  }
  return finalUrl.toString();
}
