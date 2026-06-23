import { cleanText, uniqueMediaReferences } from "./media";
import type { DouyinKind } from "../../types/douyin";
import type { ResolvedDouyinWork } from "../../types/douyin";

type DouyinDetailPayload = {
  aweme_detail?: {
    article_info?: {
      article_content?: unknown;
    };
    author?: {
      nickname?: unknown;
      sec_uid?: unknown;
      secUid?: unknown;
    };
    caption?: unknown;
    desc?: unknown;
    images?: unknown;
    item_title?: unknown;
    itemTitle?: unknown;
    music?: unknown;
    preview_title?: unknown;
    previewTitle?: unknown;
    share_info?: {
      share_desc_info?: unknown;
    };
    video?: unknown;
  };
};

type DetailRequest = {
  label: string;
  parse: (body: string, work: Pick<ResolvedDouyinWork, "id" | "kind">) => unknown;
  url: string;
  headers: Record<string, string>;
};

type DetailAttempt = {
  label: string;
  reason: string;
  status?: number;
  body?: string;
};

const DETAIL_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const SHARE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

export type DouyinWorkMetadata = {
  authorName?: string;
  authorUrl?: string;
  articleText?: string;
  caption?: string;
  coverUrls?: string[];
  title?: string;
  imageUrls?: string[];
  videoUrls?: string[];
};

export async function collectWorkMetadata(
  work: Pick<ResolvedDouyinWork, "finalUrl" | "id" | "kind">,
): Promise<DouyinWorkMetadata> {
  const attempts: DetailAttempt[] = [];
  let collected: DouyinWorkMetadata = {};

  for (const request of buildDetailRequests(work)) {
    const payload = await fetchDetailPayload(request, attempts, work);
    const detail = readAwemeDetail(payload);
    if (!detail) {
      continue;
    }

    const metadata = parseWorkMetadata({ aweme_detail: detail }, work.id, work.kind);
    if (hasMetadata(metadata)) {
      collected = mergeMetadata(collected, metadata);
      if (hasPrimaryContent(collected)) {
        return collected;
      }
      continue;
    }

    attempts.push({
      label: request.label,
      reason: "aweme_detail parsed without usable metadata",
    });
  }

  if (hasMetadata(collected)) {
    return collected;
  }

  warnMetadataFailure(work, attempts);
  return {};
}

export function parseWorkMetadata(
  payload: unknown,
  workId: string,
  kind?: DouyinKind,
): DouyinWorkMetadata {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const detail = readAwemeDetail(payload);
  if (!detail) {
    return {};
  }

  const author = detail.author;
  const secUid = readString(author?.sec_uid) ?? readString(author?.secUid);
  const coverUrls = readCoverUrls(detail, kind);
  const videoUrls = kind === "video" ? readVideoUrls(detail.video) : [];

  return {
    authorName: cleanText(readString(author?.nickname)),
    authorUrl: buildAuthorUrl(secUid, workId),
    articleText: readArticleText(detail.article_info?.article_content),
    caption: readCaption(detail, kind),
    coverUrls,
    title: cleanText(readString(detail.preview_title) ?? readString(detail.previewTitle)),
    imageUrls: kind === "note" ? readImageUrls(detail.images) : [],
    videoUrls,
  };
}

export function buildAuthorUrl(secUid: string | undefined, workId: string): string | undefined {
  if (!secUid) {
    return undefined;
  }

  const url = new URL(`/user/${encodeURIComponent(secUid)}`, "https://www.douyin.com");
  url.searchParams.set("from_tab_name", "main");
  url.searchParams.set("vid", workId);
  return url.toString();
}

function buildDetailRequests(work: Pick<ResolvedDouyinWork, "finalUrl" | "id" | "kind">): DetailRequest[] {
  const headers = buildRequestHeaders(work.finalUrl);

  return [
    {
      label: "share-page-ssr",
      url: buildSharePageUrl(work),
      headers: buildSharePageHeaders(),
      parse: parseSharePagePayload,
    },
    {
      label: "web-detail-aid-6383",
      url: buildDetailApiUrl(work.id, "6383"),
      headers,
      parse: parseJson,
    },
    {
      label: "web-detail-aid-1128",
      url: buildDetailApiUrl(work.id, "1128"),
      headers,
      parse: parseJson,
    },
  ];
}

function buildSharePageUrl(work: Pick<ResolvedDouyinWork, "id" | "kind">): string {
  return new URL(`/share/${work.kind}/${work.id}`, "https://www.douyin.com").toString();
}

function buildDetailApiUrl(workId: string, aid: string): string {
  const url = new URL("https://www.douyin.com/aweme/v1/web/aweme/detail/");
  url.searchParams.set("aweme_id", workId);
  url.searchParams.set("aid", aid);
  url.searchParams.set("version_name", "23.5.0");
  url.searchParams.set("device_platform", "webapp");
  return url.toString();
}

function buildRequestHeaders(referer: string): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    referer,
    "user-agent": DETAIL_USER_AGENT,
  };
}

function buildSharePageHeaders(): Record<string, string> {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "user-agent": SHARE_USER_AGENT,
  };
}

async function fetchDetailPayload(
  request: DetailRequest,
  attempts: DetailAttempt[],
  work: Pick<ResolvedDouyinWork, "id" | "kind">,
): Promise<unknown> {
  try {
    const response = await fetch(request.url, {
      cache: "no-store",
      headers: request.headers,
      signal: AbortSignal.timeout(readPositiveNumber(process.env.DOUYIN_METADATA_TIMEOUT_MS, 12_000)),
    });
    const text = await response.text();

    if (!response.ok) {
      attempts.push({
        label: request.label,
        reason: "upstream http error",
        status: response.status,
        body: truncateBody(text),
      });
      return null;
    }

    const payload = request.parse(text, work);
    if (!payload) {
      attempts.push({
        label: request.label,
        reason: "invalid json",
        status: response.status,
        body: truncateBody(text),
      });
      return null;
    }

    if (!readAwemeDetail(payload)) {
      attempts.push({
        label: request.label,
        reason: "missing aweme_detail",
        status: response.status,
        body: truncateBody(text),
      });
      return null;
    }

    return payload;
  } catch (error) {
    attempts.push({
      label: request.label,
      reason: error instanceof Error ? error.message : "request failed",
    });
    return null;
  }
}

function parseSharePagePayload(value: string, work: Pick<ResolvedDouyinWork, "id" | "kind">): unknown {
  const match = value.match(/<script>window\._ROUTER_DATA = ([\s\S]*?)<\/script>/u);
  if (!match) {
    return null;
  }

  const data = parseJson(match[1].trim());
  const item = findSharedAwemeItem(data, work.id);
  return item ? { aweme_detail: item } : null;
}

function findSharedAwemeItem(value: unknown, workId: string): unknown {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const itemList = record.item_list ?? record.itemList;
  if (Array.isArray(itemList)) {
    return itemList.find((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }
      const itemRecord = item as Record<string, unknown>;
      return readString(itemRecord.aweme_id ?? itemRecord.awemeId) === workId;
    }) ?? itemList[0] ?? null;
  }

  for (const child of Object.values(record)) {
    const item = findSharedAwemeItem(child, workId);
    if (item) {
      return item;
    }
  }

  return null;
}

function readAwemeDetail(payload: unknown): DouyinDetailPayload["aweme_detail"] | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const detail = (payload as DouyinDetailPayload).aweme_detail;
  return detail && typeof detail === "object" ? detail : undefined;
}

function hasMetadata(metadata: DouyinWorkMetadata): boolean {
  return Boolean(
    metadata.authorName ||
    metadata.articleText ||
    metadata.caption ||
    metadata.title ||
    metadata.coverUrls?.length ||
    metadata.videoUrls?.length ||
    metadata.imageUrls?.length,
  );
}

function hasPrimaryContent(metadata: DouyinWorkMetadata): boolean {
  return Boolean(
    metadata.articleText ||
    metadata.coverUrls?.length ||
    metadata.videoUrls?.length ||
    metadata.imageUrls?.length,
  );
}

function mergeMetadata(
  current: DouyinWorkMetadata,
  next: DouyinWorkMetadata,
): DouyinWorkMetadata {
  const coverUrls = uniqueMediaReferences([...(current.coverUrls ?? []), ...(next.coverUrls ?? [])]);
  const imageUrls = uniqueMediaReferences([...(current.imageUrls ?? []), ...(next.imageUrls ?? [])]);
  const videoUrls = uniqueMediaReferences([...(current.videoUrls ?? []), ...(next.videoUrls ?? [])]);

  return {
    authorName: current.authorName ?? next.authorName,
    authorUrl: current.authorUrl ?? next.authorUrl,
    articleText: current.articleText ?? next.articleText,
    caption: current.caption ?? next.caption,
    coverUrls,
    title: current.title ?? next.title,
    imageUrls,
    videoUrls,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function truncateBody(value: string): string | undefined {
  const text = value.trim();
  return text ? text.slice(0, 400) : undefined;
}

function warnMetadataFailure(
  work: Pick<ResolvedDouyinWork, "id" | "kind">,
  attempts: DetailAttempt[],
): void {
  console.warn("[douyin] metadata collection failed", {
    id: work.id,
    kind: work.kind,
    attempts,
  });
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readArticleText(value: unknown): string | undefined {
  const article = parseArticleContent(value);
  return cleanText(stripArticleMarkdown(article?.markdown ?? article?.long_article_abstract));
}

function readCaption(
  detail: NonNullable<DouyinDetailPayload["aweme_detail"]>,
  kind: DouyinKind | undefined,
): string | undefined {
  if (kind === "note") {
    return cleanText(stripSharePrefix(readString(detail.share_info?.share_desc_info)));
  }

  return readBestCaption([
    readString(detail.caption),
    readString(detail.desc),
    readString(detail.preview_title) ?? readString(detail.previewTitle),
    readString(detail.item_title) ?? readString(detail.itemTitle),
  ]);
}

function readBestCaption(values: Array<string | undefined>): string | undefined {
  return values
    .map((value) => cleanText(value))
    .filter((value): value is string => Boolean(value))
    .filter((value) => !isOutdatedClientNotice(value))
    .sort((left, right) => captionScore(right) - captionScore(left))[0];
}

function captionScore(value: string): number {
  return value.replace(/#[\p{L}\p{N}_-]+/gu, "").trim().length * 10 + value.length;
}

function isOutdatedClientNotice(value: string): boolean {
  return value.includes("版本过低") && value.includes("升级后可展示全部信息");
}

function parseArticleContent(value: unknown): { markdown?: string; long_article_abstract?: string } | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    try {
      return parseArticleContent(JSON.parse(value));
    } catch {
      return null;
    }
  }

  if (typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    markdown: readString(record.markdown),
    long_article_abstract: readString(record.long_article_abstract),
  };
}

function stripArticleMarkdown(value: string | undefined): string | undefined {
  return value
    ?.replace(/\\n/g, "\n")
    ?.replace(/!\[[^\]]*]\([^)]*\)/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\[[^\]]+]\([^)]*\)/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

function stripSharePrefix(value: string | undefined): string | undefined {
  return value?.replace(/^#在抖音，记录美好生活#/u, "").trim();
}

function readImageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return uniqueMediaReferences(
    value.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      return readPrimaryImageUrl(item as Record<string, unknown>) ?? [];
    }),
  );
}

function readPrimaryImageUrl(record: Record<string, unknown>): string | undefined {
  return (
    readUrlList(record.url_list ?? record.urlList)[0] ??
    readUrlList(record.download_url_list ?? record.downloadUrlList)[0]
  );
}

function readCoverUrls(
  detail: NonNullable<DouyinDetailPayload["aweme_detail"]>,
  kind: DouyinKind | undefined,
): string[] {
  const video = detail.video && typeof detail.video === "object"
    ? detail.video as Record<string, unknown>
    : null;

  return uniqueMediaReferences(
    [
      ...readCoverUrlsFromVideo(video),
      ...(kind === "note" ? readImageUrls(detail.images) : []),
    ],
  );
}

function readCoverUrlsFromVideo(video: Record<string, unknown> | null): string[] {
  if (!video) {
    return [];
  }

  return uniqueMediaReferences([
    ...readUrlList(video.cover),
    ...readUrlList(video.origin_cover ?? video.originCover),
    ...readUrlList(video.dynamic_cover ?? video.dynamicCover),
  ]);
}

function readVideoUrls(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const video = value as Record<string, unknown>;
  return uniqueMediaReferences([
    ...readBitRateVideoUrls(video.bit_rate ?? video.bitRate),
    ...readUrlList(video.play_addr ?? video.playAddr),
    ...readUrlList(video.download_addr ?? video.downloadAddr),
  ]);
}

function readBitRateVideoUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const record = item as Record<string, unknown>;
      const urls = readUrlList(record.play_addr ?? record.playAddr);
      const bitRate = readNumber(record.bit_rate ?? record.bitRate) ?? 0;
      const playAddr = record.play_addr ?? record.playAddr;
      const width = readNestedNumber(playAddr, "width") ?? 0;
      const height = readNestedNumber(playAddr, "height") ?? 0;
      return urls.length > 0
        ? [{ bitRate, pixels: width * height, urls }]
        : [];
    })
    .sort((left, right) => right.pixels - left.pixels || right.bitRate - left.bitRate)
    .flatMap((item) => item.urls);
}

function readNestedNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return readNumber((value as Record<string, unknown>)[key]);
}

function readUrlList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((url): url is string => typeof url === "string" && url.trim().startsWith("http"));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const list = record.url_list ?? record.urlList;
  if (Array.isArray(list)) {
    return list.filter((url): url is string => typeof url === "string" && url.trim().startsWith("http"));
  }

  if (list && typeof list === "object") {
    return Object.values(list)
      .flatMap((item) => Array.isArray(item) ? item : [item])
      .filter((url): url is string => typeof url === "string" && url.trim().startsWith("http"));
  }

  return Object.values(record)
    .filter((url): url is string => typeof url === "string" && url.trim().startsWith("http"));
}
