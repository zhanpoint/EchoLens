import type { DouyinKind, DouyinWorkIdentity } from "@/types/douyin";
import {
  extractFirstUrl as extractMediaUrl,
  MediaRedirectError,
  resolveMediaUrl,
} from "@/lib/media/redirect";

const CANONICAL_DOUYIN_ORIGIN = "https://www.douyin.com";

export class DouyinResolveError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_url"
      | "unsupported_host"
      | "unsupported_type"
      | "network_error",
  ) {
    super(message);
  }
}

export function extractFirstUrl(input: string): string {
  try {
    return extractMediaUrl(input);
  } catch (error) {
    if (error instanceof MediaRedirectError) {
      throw new DouyinResolveError(
        error.message,
        error.code === "unsupported_source" ? "unsupported_host" : error.code,
      );
    }
    throw error;
  }
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

export async function resolveDouyinUrl(
  inputUrl: string,
  options: { finalUrl?: string } = {},
): Promise<DouyinWorkIdentity> {
  let finalUrl = options.finalUrl;
  if (!finalUrl) {
    try {
      finalUrl = (await resolveMediaUrl(inputUrl)).finalUrl;
    } catch (error) {
      if (error instanceof MediaRedirectError) {
        throw new DouyinResolveError(
          error.message,
          error.code === "unsupported_source" ? "unsupported_host" : error.code,
        );
      }
      throw error;
    }
  }
  const classified = classifyDouyinUrl(finalUrl);

  return {
    inputUrl,
    ...classified,
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
