import { cleanText, readDouyinAvatarUrl } from "./media";
import {
  createDouyinWebClient,
  DOUYIN_BASE_URL,
  type DouyinWebClient,
} from "./web-client";

export { DouyinApiError, normalizeCookie } from "./web-client";

export type DouyinFavoriteVideo = {
  author: string;
  authorId: string;
  isFollowing: boolean;
  publishedAt: number;
  title: string;
  url: string;
};

export type DouyinFavoriteAuthor = {
  avatarUrl: string;
  id: string;
  name: string;
};

export type DouyinFavoritesSnapshot = {
  authors: DouyinFavoriteAuthor[];
  videos: DouyinFavoriteVideo[];
};

export type DouyinFavoriteSettings = {
  cookie: string;
};

type PagedResponse = {
  hasMore: boolean;
  items: unknown[];
  maxCursor: number;
};

const MAX_COLLECT_FOLDERS = 100;
const MAX_VIDEOS = 5_000;

export async function collectDouyinFavorites(
  settings: DouyinFavoriteSettings,
): Promise<DouyinFavoritesSnapshot> {
  const client = createDouyinWebClient(settings.cookie);
  const self = await client.getSelfProfile();
  const secUid = readString(self.sec_uid ?? self.secUid);
  const folders = await collectAllPages(
    (cursor) => requestCollectFolders(cursor, client),
    MAX_COLLECT_FOLDERS,
  );
  const videos: DouyinFavoriteVideo[] = [];
  const authors = new Map<string, DouyinFavoriteAuthor>();
  const seen = new Set<string>();

  if (secUid) {
    const items = await collectAllPages(
      (cursor) => requestFavoriteVideos(secUid, cursor, client),
      MAX_VIDEOS,
    );
    appendAwemeVideos(videos, authors, seen, items, MAX_VIDEOS);
  }

  for (const folder of folders) {
    const collectsId = readCollectsId(folder);
    if (!collectsId || videos.length >= MAX_VIDEOS) {
      continue;
    }

    const items = await collectAllPages(
      (cursor) => requestCollectVideos(collectsId, cursor, client),
      MAX_VIDEOS - videos.length,
    );
    appendAwemeVideos(videos, authors, seen, items, MAX_VIDEOS);
  }

  return { authors: [...authors.values()], videos };
}

async function collectAllPages(
  fetchPage: (cursor: number) => Promise<PagedResponse>,
  maxItems: number,
): Promise<unknown[]> {
  const collected: unknown[] = [];
  let cursor = 0;
  let hasMore = true;

  while (hasMore && collected.length < maxItems) {
    const page = await fetchPage(cursor);
    if (page.items.length === 0) {
      break;
    }
    collected.push(...page.items.slice(0, maxItems - collected.length));
    hasMore = page.hasMore;
    if (hasMore && page.maxCursor === cursor) {
      break;
    }
    cursor = page.maxCursor;
  }

  return collected;
}

async function requestCollectFolders(
  cursor: number,
  client: DouyinWebClient,
): Promise<PagedResponse> {
  const payload = await client.request(
    "/aweme/v1/web/collects/list/",
    buildCollectPageParams(cursor, 20, client),
  );
  return normalizePagedResponse(payload, ["collects_list"]);
}

async function requestFavoriteVideos(
  secUid: string,
  maxCursor: number,
  client: DouyinWebClient,
): Promise<PagedResponse> {
  const payload = await client.request(
    "/aweme/v1/web/aweme/favorite/",
    {
      ...client.query(),
      count: 20,
      locate_query: "false",
      max_cursor: maxCursor,
      sec_user_id: secUid,
    },
  );
  return normalizePagedResponse(payload, ["aweme_list"]);
}

async function requestCollectVideos(
  collectsId: string,
  cursor: number,
  client: DouyinWebClient,
): Promise<PagedResponse> {
  const payload = await client.request(
    "/aweme/v1/web/collects/video/list/",
    {
      ...buildCollectPageParams(cursor, 20, client),
      collects_id: collectsId,
    },
  );
  return normalizePagedResponse(payload, ["aweme_list"]);
}

function appendAwemeVideos(
  videos: DouyinFavoriteVideo[],
  authors: Map<string, DouyinFavoriteAuthor>,
  seen: Set<string>,
  items: unknown[],
  maxVideos: number,
): void {
  for (const item of items) {
    const aweme = readAweme(item);
    const id = readString(aweme.aweme_id ?? aweme.awemeId);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const author = readRecord(aweme.author);
    const authorName = readAuthorName(author);
    const authorId = readString(author.sec_uid ?? author.secUid ?? author.uid);
    const authorKey = authorId || authorName;
    if (!authors.has(authorKey)) {
      authors.set(authorKey, {
        avatarUrl: readDouyinAvatarUrl(author),
        id: authorId,
        name: authorName,
      });
    }
    videos.push({
      author: authorName,
      authorId,
      isFollowing: readInteger(author.follow_status ?? author.followStatus) > 0,
      publishedAt: readInteger(aweme.create_time ?? aweme.createTime),
      title: readTitle(aweme),
      url: new URL(`/video/${encodeURIComponent(id)}`, DOUYIN_BASE_URL).toString(),
    });
    if (videos.length >= maxVideos) {
      break;
    }
  }
}

function buildCollectPageParams(
  cursor: number,
  count: number,
  client: DouyinWebClient,
): Record<string, string | number> {
  return {
    ...client.query(),
    cursor,
    count,
    version_code: "170400",
    version_name: "17.4.0",
  };
}

function normalizePagedResponse(
  payload: Record<string, unknown>,
  keys: string[],
): PagedResponse {
  const items = keys
    .map((key) => payload[key])
    .find((value): value is unknown[] => Array.isArray(value)) ?? [];
  return {
    items,
    hasMore: readBoolean(payload.has_more),
    maxCursor: readInteger(payload.max_cursor ?? payload.cursor),
  };
}


function readCollectsId(value: unknown): string {
  const item = readRecord(value);
  return readString(
    item.collects_id ??
    item.collects_id_str ??
    item.id ??
    readRecord(item.collects_info).collects_id ??
    readRecord(item.collects_info).collects_id_str,
  );
}

function readAweme(value: unknown): Record<string, unknown> {
  const item = readRecord(value);
  const nested = readRecord(item.aweme_info ?? item.aweme ?? item.aweme_detail);
  return Object.keys(nested).length > 0 ? nested : item;
}

function readAuthorName(author: Record<string, unknown>): string {
  return cleanText(readString(author.nickname) || readString(author.unique_id)) || "未知作者";
}

function readTitle(aweme: Record<string, unknown>): string {
  return cleanText(
    readString(aweme.caption) ||
    readString(aweme.desc) ||
    readString(aweme.preview_title) ||
    readString(aweme.item_title),
  ) || "未命名作品";
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function readBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed !== 0 : Boolean(value);
}
