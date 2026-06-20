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

export type DouyinWorkMetadata = {
  authorName?: string;
  authorUrl?: string;
  articleText?: string;
  caption?: string;
  coverUrl?: string;
  title?: string;
  imageUrls?: string[];
  audioUrls?: string[];
  videoUrl?: string;
};

export async function collectWorkMetadata(
  work: Pick<ResolvedDouyinWork, "finalUrl" | "id" | "kind">,
): Promise<DouyinWorkMetadata> {
  const attempts: DetailAttempt[] = [];

  for (const request of buildDetailRequests(work)) {
    const payload = await fetchDetailPayload(request, attempts);
    const detail = readAwemeDetail(payload);
    if (!detail) {
      continue;
    }

    const metadata = parseWorkMetadata({ aweme_detail: detail }, work.id, work.kind);
    if (hasMetadata(metadata)) {
      return metadata;
    }

    attempts.push({
      label: request.label,
      reason: "aweme_detail parsed without usable metadata",
    });
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

  return {
    authorName: cleanText(readString(author?.nickname)),
    authorUrl: buildAuthorUrl(secUid, workId),
    articleText: readArticleText(detail.article_info?.article_content),
    caption: readCaption(detail, kind),
    coverUrl: readCoverUrl(detail, kind),
    title: cleanText(readString(detail.preview_title) ?? readString(detail.previewTitle)),
    audioUrls: readAudioUrls(detail.music, kind),
    imageUrls: kind === "note" ? readImageUrls(detail.images) : [],
    videoUrl: kind === "video" ? readVideoUrl(detail.video) : undefined,
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

function buildDetailRequests(work: Pick<ResolvedDouyinWork, "finalUrl" | "id">): DetailRequest[] {
  const headers = buildRequestHeaders(work.finalUrl);

  return [
    {
      label: "web-detail-aid-6383",
      url: buildDetailApiUrl(work.id, "6383"),
      headers,
    },
    {
      label: "web-detail-aid-1128",
      url: buildDetailApiUrl(work.id, "1128"),
      headers,
    },
  ];
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
    referer,
    "user-agent": DETAIL_USER_AGENT,
  };
}

async function fetchDetailPayload(request: DetailRequest, attempts: DetailAttempt[]): Promise<unknown> {
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

    const payload = parseJson(text);
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
    metadata.coverUrl ||
    metadata.title ||
    metadata.videoUrl ||
    metadata.audioUrls?.length ||
    metadata.imageUrls?.length,
  );
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

function readBoolean(value: unknown): boolean {
  return value === true;
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

function readCoverUrl(
  detail: NonNullable<DouyinDetailPayload["aweme_detail"]>,
  kind: DouyinKind | undefined,
): string | undefined {
  const video = detail.video && typeof detail.video === "object"
    ? detail.video as Record<string, unknown>
    : null;

  return (
    readCoverFromVideo(video) ??
    (kind === "note" ? readImageUrls(detail.images)[0] : undefined)
  );
}

function readCoverFromVideo(video: Record<string, unknown> | null): string | undefined {
  if (!video) {
    return undefined;
  }

  return (
    readUrlList(video.cover)[0] ??
    readUrlList(video.origin_cover ?? video.originCover)[0] ??
    readUrlList(video.dynamic_cover ?? video.dynamicCover)[0]
  );
}

function readAudioUrls(musicValue: unknown, kind: DouyinKind | undefined): string[] {
  const music = musicValue && typeof musicValue === "object"
    ? musicValue as Record<string, unknown>
    : null;
  if (!music || (kind === "video" && isOriginalSoundMusic(music))) {
    return [];
  }

  return uniqueMediaReferences(
    [readUrlList(music?.play_url ?? music?.playUrl)[0]]
      .filter((url): url is string => Boolean(url)),
  ).slice(0, 1);
}

function isOriginalSoundMusic(music: Record<string, unknown>): boolean {
  if (readBoolean(music.is_original_sound ?? music.isOriginalSound)) {
    return true;
  }

  return Boolean(readString(music.title)?.includes("创作的原声"));
}

function readVideoUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const video = value as Record<string, unknown>;
  return uniqueMediaReferences([
    readBitRateVideoUrl(video.bit_rate ?? video.bitRate),
    readUrlList(video.play_addr ?? video.playAddr)[0],
    readUrlList(video.download_addr ?? video.downloadAddr)[0],
  ].filter((url): url is string => Boolean(url))).slice(0, 1)[0];
}

function readBitRateVideoUrl(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const selected = value
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
    .sort((left, right) => right.pixels - left.pixels || right.bitRate - left.bitRate)[0];

  return selected?.urls[0];
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

  const list = (value as Record<string, unknown>).url_list ?? (value as Record<string, unknown>).urlList;
  if (!Array.isArray(list)) {
    return [];
  }

  return list.filter((url): url is string => typeof url === "string" && url.trim().startsWith("http"));
}
