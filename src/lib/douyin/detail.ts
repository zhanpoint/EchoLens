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
    images?: unknown;
    preview_title?: unknown;
    previewTitle?: unknown;
    share_info?: {
      share_desc_info?: unknown;
    };
    video?: unknown;
  };
};

export type DouyinWorkMetadata = {
  authorName?: string;
  authorUrl?: string;
  articleText?: string;
  caption?: string;
  title?: string;
  imageUrls?: string[];
  audioUrls?: string[];
};

export async function collectWorkMetadata(
  work: Pick<ResolvedDouyinWork, "finalUrl" | "id" | "kind">,
): Promise<DouyinWorkMetadata> {
  const response = await fetch(buildDetailApiUrl(work.id), {
    headers: {
      accept: "application/json, text/plain, */*",
      referer: work.finalUrl,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    return {};
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  return parseWorkMetadata(payload, work.id, work.kind);
}

export function parseWorkMetadata(
  payload: unknown,
  workId: string,
  kind?: DouyinKind,
): DouyinWorkMetadata {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const detail = (payload as DouyinDetailPayload).aweme_detail;
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
    title: cleanText(readString(detail.preview_title) ?? readString(detail.previewTitle)),
    audioUrls: readAudioUrls(detail.video),
    imageUrls: kind === "note" ? readImageUrls(detail.images) : [],
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

function buildDetailApiUrl(workId: string): string {
  const url = new URL("https://www.douyin.com/aweme/v1/web/aweme/detail/");
  url.searchParams.set("aweme_id", workId);
  url.searchParams.set("aid", "6383");
  url.searchParams.set("version_name", "23.5.0");
  url.searchParams.set("device_platform", "webapp");
  return url.toString();
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

  return cleanText(readString(detail.caption));
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

function readAudioUrls(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const video = value as Record<string, unknown>;
  return uniqueMediaReferences(readBitRateAudioUrls(video.bit_rate_audio ?? video.bitRateAudio)).slice(0, 1);
}

function readBitRateAudioUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const selected = value
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const record = item as Record<string, unknown>;
      const audioMeta = record.audio_meta ?? record.audioMeta;
      const urls = readAudioUrlList(audioMeta);
      const quality = readNumber(record.audio_quality ?? record.audioQuality) ?? 0;
      const bitRate = readNestedNumber(audioMeta, "bitrate") ?? 0;
      return urls.length > 0
        ? [{ quality, bitRate, urls }]
        : [];
    })
    .sort((left, right) => right.quality - left.quality || right.bitRate - left.bitRate)[0];

  return selected?.urls.slice(0, 1) ?? [];
}

function readAudioUrlList(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const urlList = (value as Record<string, unknown>).url_list ?? (value as Record<string, unknown>).urlList;
  if (!urlList || typeof urlList !== "object") {
    return [];
  }

  const record = urlList as Record<string, unknown>;
  return [record.main_url, record.mainUrl, record.backup_url, record.backupUrl]
    .filter((url): url is string => typeof url === "string" && url.trim().startsWith("http"));
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
