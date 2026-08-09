import { cleanText, uniqueMediaReferences } from "./media";
import {
  DEFAULT_DOWNLOAD_VIDEO_QUALITY,
  type DownloadVideoQuality,
} from "@/lib/download-settings";
import { fetchWithRetry } from "@/lib/http/retry";
import type { OpenApiPlatformRequestPolicy } from "@/lib/open-api/platform-request-policy";
import type { DouyinKind } from "../../types/douyin";
import type { DouyinWorkIdentity } from "../../types/douyin";

type DouyinDetailPayload = {
  aweme_detail?: {
    author?: {
      avatar_thumb?: unknown;
      avatarThumb?: unknown;
      nickname?: unknown;
      sec_uid?: unknown;
      secUid?: unknown;
    };
    caption?: unknown;
    desc?: unknown;
    item_title?: unknown;
    itemTitle?: unknown;
    preview_title?: unknown;
    previewTitle?: unknown;
    video?: unknown;
  };
};

const SHARE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const METADATA_REQUEST_TIMEOUT_MS = 12_000;

export type DouyinWorkMetadata = {
  authorName?: string;
  authorAvatarUrls?: string[];
  authorUrl?: string;
  caption?: string;
  coverUrls?: string[];
  durationSeconds?: number;
  videoUrls?: string[];
};

export type CompleteDouyinWorkMetadata = DouyinWorkMetadata & {
  authorAvatarUrls: string[];
  authorName: string;
  caption: string;
  coverUrls: string[];
  durationSeconds: number;
  videoUrls: string[];
};

export async function collectWorkMetadata(
  work: Pick<DouyinWorkIdentity, "finalUrl" | "id" | "kind">,
  options: {
    requestPolicy?: OpenApiPlatformRequestPolicy;
    signal?: AbortSignal;
    videoQuality?: DownloadVideoQuality;
  } = {},
): Promise<CompleteDouyinWorkMetadata> {
  await options.requestPolicy?.beforeRequest("douyin");
  const response = await fetchWithRetry(buildSharePageUrl(work), {
    cache: "no-store",
    headers: buildSharePageHeaders(),
    signal: options.signal,
    retry: {
      onResponse: (value) => options.requestPolicy?.observeResponse("douyin", value),
      retryHttpStatuses: [429],
      retryOnDefaultHttpStatuses: !options.requestPolicy,
      timeoutMs: METADATA_REQUEST_TIMEOUT_MS,
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`抖音作品信息请求失败：HTTP ${response.status}`);
  }

  const text = await response.text();
  options.requestPolicy?.observePayload("douyin", text);
  const payload = parseSharePagePayload(text, work);
  const metadata = parseWorkMetadata(
    payload,
    work.id,
    work.kind,
    options.videoQuality ?? DEFAULT_DOWNLOAD_VIDEO_QUALITY,
  );
  if (!hasCompleteMetadata(metadata)) {
    throw new Error("抖音作品信息不完整，请稍后重试。");
  }
  return metadata;
}

function hasCompleteMetadata(metadata: DouyinWorkMetadata): metadata is CompleteDouyinWorkMetadata {
  return Boolean(
    metadata.authorName &&
    metadata.authorAvatarUrls?.length &&
    metadata.caption &&
    metadata.coverUrls?.length &&
    metadata.videoUrls?.length &&
    metadata.durationSeconds &&
    metadata.durationSeconds > 0,
  );
}

export function parseWorkMetadata(
  payload: unknown,
  workId: string,
  kind?: DouyinKind,
  videoQuality: DownloadVideoQuality = DEFAULT_DOWNLOAD_VIDEO_QUALITY,
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
  const coverUrls = readCoverUrls(detail);
  const videoUrls = kind === "video" ? readVideoUrls(detail.video, videoQuality) : [];
  const durationSeconds = kind === "video" ? readVideoDurationSeconds(detail) : undefined;

  return {
    authorName: cleanText(readString(author?.nickname)),
    authorAvatarUrls: readUrlList(author?.avatar_thumb ?? author?.avatarThumb),
    authorUrl: buildAuthorUrl(secUid, workId),
    caption: readCaption(detail),
    coverUrls,
    durationSeconds,
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

function buildSharePageUrl(work: Pick<DouyinWorkIdentity, "id" | "kind">): string {
  return new URL(`/share/${work.kind}/${work.id}`, "https://www.douyin.com").toString();
}

function buildSharePageHeaders(): Record<string, string> {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "user-agent": SHARE_USER_AGENT,
  };
}

function parseSharePagePayload(value: string, work: Pick<DouyinWorkIdentity, "id" | "kind">): unknown {
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

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readCaption(
  detail: NonNullable<DouyinDetailPayload["aweme_detail"]>,
): string | undefined {
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

function readCoverUrls(
  detail: NonNullable<DouyinDetailPayload["aweme_detail"]>,
): string[] {
  const video = detail.video && typeof detail.video === "object"
    ? detail.video as Record<string, unknown>
    : null;

  return readCoverUrlsFromVideo(video);
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

const VIDEO_QUALITY_TARGET_WIDTH: Partial<Record<DownloadVideoQuality, number>> = {
  "1440p": 2560,
  "1080p": 1920,
  "720p": 1280,
  "540p": 960,
  "480p": 854,
  "360p": 640,
};

type BitRateVideoSource = {
  bitRate: number;
  urls: string[];
  width: number;
};

function readVideoUrls(value: unknown, quality: DownloadVideoQuality): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const video = value as Record<string, unknown>;
  const selectedUrls = readBitRateVideoUrls(video.bit_rate ?? video.bitRate, quality);
  if (selectedUrls.length) return uniqueMediaReferences(selectedUrls);
  return uniqueMediaReferences([
    ...readUrlList(video.play_addr ?? video.playAddr),
    ...readUrlList(video.download_addr ?? video.downloadAddr),
  ]);
}

function readVideoDurationSeconds(detail: NonNullable<DouyinDetailPayload["aweme_detail"]>): number | undefined {
  const detailRecord = detail as Record<string, unknown>;
  const video = detail.video && typeof detail.video === "object"
    ? detail.video as Record<string, unknown>
    : null;
  const durationMs = readNumber(video?.duration);
  if (durationMs && durationMs > 0) {
    return durationMs > 1000 ? durationMs / 1000 : durationMs;
  }

  return [
    readNumber(detailRecord.duration),
    readNumber(detailRecord.video_duration ?? detailRecord.videoDuration),
  ].find((duration): duration is number => Boolean(duration && duration > 0));
}

function readBitRateVideoUrls(value: unknown, quality: DownloadVideoQuality): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const sources = value.flatMap((item): BitRateVideoSource[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const playAddr = record.play_addr ?? record.playAddr;
    const urls = readUrlList(playAddr);
    const width = readNestedNumber(playAddr, "width") ?? readNumber(record.width);
    const bitRate = readNumber(record.bit_rate ?? record.bitRate);
    return urls.length && width
      ? [{ bitRate: bitRate ?? 0, urls, width }]
      : [];
  });
  if (!sources.length) return [];

  const targetWidth = VIDEO_QUALITY_TARGET_WIDTH[quality];
  sources.sort((left, right) => {
    if (quality === "lowest") {
      return left.bitRate - right.bitRate || left.width - right.width;
    }
    if (quality === "highest") {
      return right.bitRate - left.bitRate || right.width - left.width;
    }
    return Math.abs(left.width - (targetWidth ?? 0)) - Math.abs(right.width - (targetWidth ?? 0))
      || right.bitRate - left.bitRate;
  });
  return sources.flatMap(({ urls }) => urls);
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
