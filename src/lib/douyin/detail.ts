import { cleanText, uniqueMediaReferences } from "./media";
import { createDouyinWebClient, DouyinApiError, isDouyinCredentialError, type DouyinClientOptions } from "./web-client";
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
      avatar_larger?: unknown;
      avatar_medium?: unknown;
      avatar_thumb?: unknown;
      avatarLarger?: unknown;
      avatarMedium?: unknown;
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
const DETAIL_AID_CANDIDATES = ["6383", "1128"] as const;

export class DouyinMetadataError extends Error {
  constructor(
    message: string,
    readonly code: "credential_invalid" | "credential_required" | "incomplete_metadata",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DouyinMetadataError";
  }
}

export type DouyinWorkMetadata = {
  audioUrls?: string[];
  dashVideoUrls?: string[];
  dubbingAudioUrls?: string[];
  dubbingTitle?: string;
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
    credentialCookie?: string;
    requestPolicy?: OpenApiPlatformRequestPolicy;
    signal?: AbortSignal;
    videoQuality?: DownloadVideoQuality;
  } = {},
): Promise<CompleteDouyinWorkMetadata> {
  const videoQuality = options.videoQuality ?? DEFAULT_DOWNLOAD_VIDEO_QUALITY;
  const apiPayload = options.credentialCookie
    ? await collectWebApiPayload(work, options.credentialCookie, options).catch((error: unknown) => {
        if (isDouyinCredentialError(error)) {
          throw new DouyinMetadataError(
            "抖音账号访问凭证已失效，请前往设置更新 Cookie 后重试。",
            "credential_invalid",
            error,
          );
        }
        throw error;
      })
    : null;
  const apiMetadata = parseWorkMetadata(apiPayload, work.id, work.kind, videoQuality);
  if (hasCompleteMetadata(apiMetadata)) return apiMetadata;

  const sharePayload = await collectSharePagePayload(work, options);
  const shareMetadata = parseWorkMetadata(sharePayload, work.id, work.kind, videoQuality);
  const metadata = mergeWorkMetadata(apiMetadata, shareMetadata);
  if (hasCompleteMetadata(metadata)) return metadata;

  const missingFields = missingMetadataFields(metadata);
  throw new DouyinMetadataError(
    options.credentialCookie
      ? `抖音作品核心信息不完整，缺少：${missingFields.join("、")}。`
      : "抖音公开分享页未返回完整作品信息，请先在设置中配置有效的抖音 Cookie 后重试。",
    options.credentialCookie ? "incomplete_metadata" : "credential_required",
  );
}

async function collectWebApiPayload(
  work: Pick<DouyinWorkIdentity, "finalUrl" | "id" | "kind">,
  credentialCookie: string,
  options: DouyinClientOptions,
): Promise<unknown> {
  const client = createDouyinWebClient(credentialCookie, options);
  let loginError: DouyinApiError | undefined;
  for (const aid of DETAIL_AID_CANDIDATES) {
    try {
      const payload = await client.request(
        "/aweme/v1/web/aweme/detail/",
        { ...client.query(), aid, aweme_id: work.id },
        3,
      );
      if (payload.aweme_detail) return payload;
    } catch (error) {
      if (error instanceof DouyinApiError && error.code === "LOGIN_REQUIRED") {
        loginError = error;
      } else {
        throw error;
      }
    }
  }
  if (loginError) await client.verifyAuthenticatedSession(1);
  return null;
}

async function collectSharePagePayload(
  work: Pick<DouyinWorkIdentity, "id" | "kind">,
  options: {
    requestPolicy?: OpenApiPlatformRequestPolicy;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  await options.requestPolicy?.beforeRequest("douyin", options.signal);
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
    if (response.status === 403 || response.status === 429) {
      throw new DouyinMetadataError(
        "抖音公开分享页触发风控，请先在设置中配置有效的抖音 Cookie 后重试。",
        "credential_required",
      );
    }
    throw new Error(`抖音作品信息请求失败：HTTP ${response.status}`);
  }

  const text = await response.text();
  const payload = parseSharePagePayload(text, work);
  if (payload) options.requestPolicy?.observePayload("douyin", payload);
  return payload;
}

function hasCompleteMetadata(metadata: DouyinWorkMetadata): metadata is CompleteDouyinWorkMetadata {
  return missingMetadataFields(metadata).length === 0;
}

function missingMetadataFields(metadata: DouyinWorkMetadata): string[] {
  const missing: string[] = [];
  if (!metadata.authorName) missing.push("作者名");
  if (!metadata.authorAvatarUrls?.length) missing.push("作者头像");
  if (!metadata.caption) missing.push("作品标题");
  if (!metadata.coverUrls?.length) missing.push("作品封面");
  if (!metadata.videoUrls?.length) missing.push("视频地址");
  if (!metadata.durationSeconds || metadata.durationSeconds <= 0) missing.push("视频时长");
  return missing;
}

function mergeWorkMetadata(primary: DouyinWorkMetadata, fallback: DouyinWorkMetadata): DouyinWorkMetadata {
  return {
    audioUrls: uniqueMediaReferences([
      ...(primary.audioUrls ?? []),
      ...(fallback.audioUrls ?? []),
    ]),
    dashVideoUrls: uniqueMediaReferences([
      ...(primary.dashVideoUrls ?? []),
      ...(fallback.dashVideoUrls ?? []),
    ]),
    dubbingAudioUrls: uniqueMediaReferences([
      ...(primary.dubbingAudioUrls ?? []),
      ...(fallback.dubbingAudioUrls ?? []),
    ]),
    dubbingTitle: primary.dubbingTitle ?? fallback.dubbingTitle,
    authorName: primary.authorName ?? fallback.authorName,
    authorAvatarUrls: uniqueMediaReferences([
      ...(primary.authorAvatarUrls ?? []),
      ...(fallback.authorAvatarUrls ?? []),
    ]),
    authorUrl: primary.authorUrl ?? fallback.authorUrl,
    caption: primary.caption ?? fallback.caption,
    coverUrls: uniqueMediaReferences([
      ...(primary.coverUrls ?? []),
      ...(fallback.coverUrls ?? []),
    ]),
    durationSeconds: primary.durationSeconds ?? fallback.durationSeconds,
    videoUrls: uniqueMediaReferences([
      ...(primary.videoUrls ?? []),
      ...(fallback.videoUrls ?? []),
    ]),
  };
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

  const detailRecord = detail as Record<string, unknown>;
  const author = detail.author;
  const secUid = readString(author?.sec_uid) ?? readString(author?.secUid);
  const coverUrls = readCoverUrls(detail);
  const audioUrls = kind === "video" ? readAudioUrls(detail.video) : [];
  const dashVideoUrls = kind === "video" ? readDashVideoUrls(detail.video, videoQuality) : [];
  const dubbing = readDubbing(detailRecord.music);
  const videoUrls = kind === "video" ? readVideoUrls(detail.video) : [];
  const durationSeconds = kind === "video" ? readVideoDurationSeconds(detail) : undefined;

  return {
    audioUrls,
    dashVideoUrls,
    dubbingAudioUrls: dubbing.urls,
    dubbingTitle: dubbing.title,
    authorName: cleanText(readString(author?.nickname)),
    authorAvatarUrls: uniqueMediaReferences([
      ...readUrlList(author?.avatar_larger ?? author?.avatarLarger),
      ...readUrlList(author?.avatar_medium ?? author?.avatarMedium),
      ...readUrlList(author?.avatar_thumb ?? author?.avatarThumb),
    ]),
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

function readDashVideoUrls(value: unknown, quality: DownloadVideoQuality): string[] {
  if (!value || typeof value !== "object") return [];
  const bitRates = (value as Record<string, unknown>).bit_rate ?? (value as Record<string, unknown>).bitRate;
  if (!Array.isArray(bitRates)) return [];
  const sources = bitRates.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const playAddr = record.play_addr ?? record.playAddr;
    const urls = readUrlList(playAddr);
    const width = readNestedNumber(playAddr, "width") ?? readNumber(record.width) ?? 0;
    const bitRate = readNumber(record.bit_rate ?? record.bitRate) ?? 0;
    return urls.length ? [{ bitRate, urls, width }] : [];
  });
  if (!sources.length) return [];
  const target = VIDEO_QUALITY_TARGET_WIDTH[quality];
  sources.sort((left, right) => quality === "lowest"
    ? left.bitRate - right.bitRate || left.width - right.width
    : quality === "highest"
      ? right.width - left.width || right.bitRate - left.bitRate
      : Math.abs(left.width - (target ?? 0)) - Math.abs(right.width - (target ?? 0)) || right.bitRate - left.bitRate);
  return sources[0].urls;
}

function readDubbing(value: unknown): { title?: string; urls: string[] } {
  if (!value || typeof value !== "object") return { urls: [] };
  const music = value as Record<string, unknown>;
  return {
    title: cleanText(readString(music.title)),
    urls: readUrlList(music.play_url ?? music.playUrl),
  };
}

function readNestedNumber(value: unknown, key: string): number | undefined {
  return value && typeof value === "object"
    ? readNumber((value as Record<string, unknown>)[key])
    : undefined;
}

function readAudioUrls(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const video = value as Record<string, unknown>;
  const bitRateAudio = video.bit_rate_audio ?? video.bitRateAudio;
  return uniqueMediaReferences([
    ...readUrlList(video.audio),
    ...(Array.isArray(bitRateAudio)
      ? bitRateAudio.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const record = item as Record<string, unknown>;
          const meta = record.audio_meta ?? record.audioMeta;
          return [...readUrlList(meta), ...readUrlList(record.play_addr ?? record.playAddr)];
        })
      : []),
  ]);
}

function readVideoUrls(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const video = value as Record<string, unknown>;
  return uniqueMediaReferences([
    ...readUrlList(video.play_addr ?? video.playAddr),
    ...readUrlList(video.play_addr_h264 ?? video.playAddrH264),
    ...readUrlList(video.play_addr_265 ?? video.playAddr265),
    ...readUrlList(video.play_addr_256 ?? video.playAddr256),
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
