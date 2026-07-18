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
  commentCount: number;
  coverUrl: string;
  favoriteCount: number;
  isFollowing: boolean;
  likeCount: number;
  publishedAt: number;
  title: string;
  url: string;
};

export type DouyinFavoriteAuthor = {
  avatarUrl: string;
  followerCount: number;
  id: string;
  name: string;
  signature: string;
  uniqueId: string;
  workCount: number;
};

export type DouyinFavoriteFolder = {
  id: string;
  isPrivate: boolean;
  name: string;
  total: number;
  works: DouyinFavoriteVideo[];
};

export type DouyinFavoriteMix = {
  coverUrl: string;
  id: string;
  name: string;
  playCount: number;
  total: number;
  url: string;
  works: DouyinFavoriteVideo[];
};

export type DouyinFavoritesSnapshot = {
  authors: DouyinFavoriteAuthor[];
  folders: DouyinFavoriteFolder[];
  mixes: DouyinFavoriteMix[];
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

type ItemBudget = {
  remaining: number;
};

type AsyncLimiter = <T>(task: () => Promise<T>) => Promise<T>;

const MAX_COLLECT_FOLDERS = 100;
const MAX_COLLECT_MIXES = 100;
const MAX_WORKS_PER_CATEGORY = 5_000;
const PAGE_SIZE = 20;
const GROUP_FETCH_CONCURRENCY = 4;

export async function collectDouyinFavorites(
  settings: DouyinFavoriteSettings,
): Promise<DouyinFavoritesSnapshot> {
  const client = createDouyinWebClient(settings.cookie);
  const self = await client.getSelfProfile();
  const secUid = readString(self.sec_uid ?? self.secUid);
  const folderAuthors = new Map<string, DouyinFavoriteAuthor>();
  const mixAuthors = new Map<string, DouyinFavoriteAuthor>();
  const expandGroup = createConcurrencyLimiter(GROUP_FETCH_CONCURRENCY);
  const [folders, favoriteItems, mixes] = await Promise.all([
    collectAllPages(
      (cursor) => requestCollectFolders(cursor, client),
      MAX_COLLECT_FOLDERS,
    ).then((items) => collectFolders(items, client, folderAuthors, expandGroup)),
    secUid
      ? collectAllPages(
          (cursor) => requestFavoriteVideos(secUid, cursor, client),
          MAX_WORKS_PER_CATEGORY,
        )
      : Promise.resolve([]),
    collectAllPages(
      (cursor) => requestFavoriteMixes(cursor, client),
      MAX_COLLECT_MIXES,
    ).then((items) => collectMixes(items, client, mixAuthors, expandGroup)),
  ]);

  const authors = new Map<string, DouyinFavoriteAuthor>();
  const videos: DouyinFavoriteVideo[] = [];
  appendAwemeVideos(videos, authors, new Set<string>(), favoriteItems, MAX_WORKS_PER_CATEGORY);
  mergeAuthors(authors, folderAuthors);
  mergeAuthors(authors, mixAuthors);

  return { authors: [...authors.values()], folders, mixes, videos };
}

async function collectFolders(
  items: unknown[],
  client: DouyinWebClient,
  authors: Map<string, DouyinFavoriteAuthor>,
  expandGroup: AsyncLimiter,
): Promise<DouyinFavoriteFolder[]> {
  const budget = { remaining: MAX_WORKS_PER_CATEGORY };
  const folders = await Promise.all(items.map((value) => expandGroup(async () => {
    const item = readRecord(value);
    const info = readRecord(item.collects_info);
    const id = readCollectsId(item);
    if (!id) {
      return null;
    }

    const works = budget.remaining > 0
      ? await collectAllPages(
          (cursor) => requestCollectVideos(id, cursor, client),
          MAX_WORKS_PER_CATEGORY,
          budget,
        )
      : [];
    const normalizedWorks: DouyinFavoriteVideo[] = [];
    appendAwemeVideos(
      normalizedWorks,
      authors,
      new Set<string>(),
      works,
      works.length,
    );

    return {
      id,
      isPrivate: item.is_private === undefined && info.is_private === undefined
        ? true
        : readBoolean(item.is_private ?? info.is_private),
      name: cleanText(
        readString(item.collects_name) ||
        readString(info.collects_name) ||
        readString(item.name) ||
        readString(info.name),
      ) || "未命名收藏夹",
      total: Math.max(
        normalizedWorks.length,
        readInteger(
          item.total_number ??
          item.aweme_count ??
          item.collects_count ??
          item.item_count ??
          info.total_number ??
          info.aweme_count ??
          info.collects_count ??
          info.item_count,
        ),
      ),
      works: normalizedWorks,
    } satisfies DouyinFavoriteFolder;
  })));

  return folders.filter((folder): folder is DouyinFavoriteFolder => folder !== null);
}

async function collectMixes(
  items: unknown[],
  client: DouyinWebClient,
  authors: Map<string, DouyinFavoriteAuthor>,
  expandGroup: AsyncLimiter,
): Promise<DouyinFavoriteMix[]> {
  const budget = { remaining: MAX_WORKS_PER_CATEGORY };
  const mixes = await Promise.all(items.map((value) => expandGroup(async () => {
    const item = unwrapMix(value);
    const id = readIdentifier(item.mix_id_str, item.mix_id, item.mixId, item.id);
    if (!id) {
      return null;
    }

    const works = budget.remaining > 0
      ? await collectAllPages(
          (cursor) => requestMixVideos(id, cursor, client),
          MAX_WORKS_PER_CATEGORY,
          budget,
        )
      : [];
    const normalizedWorks: DouyinFavoriteVideo[] = [];
    appendAwemeVideos(
      normalizedWorks,
      authors,
      new Set<string>(),
      works,
      works.length,
    );

    const statistics = readRecord(item.statistics ?? item.stats ?? item.statis);
    return {
      coverUrl: readMixCoverUrl(item) || normalizedWorks[0]?.coverUrl || "",
      id,
      name: cleanText(
        readString(item.mix_name) ||
        readString(item.title) ||
        readString(item.name),
      ) || "未命名合集",
      playCount: readInteger(item.play_count ?? statistics.play_count),
      total: Math.max(
        normalizedWorks.length,
        readInteger(
          item.aweme_count ??
          item.total_episode ??
          item.episode_count ??
          item.updated_to_episode ??
          item.item_count ??
          item.count,
        ),
      ),
      url: new URL(`/collection/${encodeURIComponent(id)}`, DOUYIN_BASE_URL).toString(),
      works: normalizedWorks,
    } satisfies DouyinFavoriteMix;
  })));

  return mixes.filter((mix): mix is DouyinFavoriteMix => mix !== null);
}

async function collectAllPages(
  fetchPage: (cursor: number) => Promise<PagedResponse>,
  maxItems: number,
  budget?: ItemBudget,
): Promise<unknown[]> {
  const collected: unknown[] = [];
  let cursor = 0;
  let hasMore = true;

  while (hasMore && collected.length < maxItems && (!budget || budget.remaining > 0)) {
    const page = await fetchPage(cursor);
    if (page.items.length === 0) {
      break;
    }
    const count = Math.min(
      page.items.length,
      maxItems - collected.length,
      budget?.remaining ?? Number.POSITIVE_INFINITY,
    );
    collected.push(...page.items.slice(0, count));
    if (budget) {
      budget.remaining -= count;
    }
    hasMore = page.hasMore;
    if (hasMore && page.maxCursor === cursor) {
      break;
    }
    cursor = page.maxCursor;
  }

  return collected;
}

function createConcurrencyLimiter(concurrency: number): AsyncLimiter {
  let active = 0;
  const waiters: Array<() => void> = [];

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiters.shift();
      if (next) {
        next();
      } else {
        active -= 1;
      }
    }
  };
}

async function requestCollectFolders(
  cursor: number,
  client: DouyinWebClient,
): Promise<PagedResponse> {
  const payload = await client.request(
    "/aweme/v1/web/collects/list/",
    buildCollectPageParams(cursor, PAGE_SIZE, client),
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
      count: PAGE_SIZE,
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
      ...buildCollectPageParams(cursor, PAGE_SIZE, client),
      collects_id: collectsId,
    },
  );
  return normalizePagedResponse(payload, ["aweme_list"]);
}

async function requestFavoriteMixes(
  cursor: number,
  client: DouyinWebClient,
): Promise<PagedResponse> {
  const payload = await client.request(
    "/aweme/v1/web/mix/listcollection/",
    buildCollectPageParams(cursor, PAGE_SIZE, client),
  );
  return normalizePagedResponse(payload, ["mix_infos"]);
}

async function requestMixVideos(
  mixId: string,
  cursor: number,
  client: DouyinWebClient,
): Promise<PagedResponse> {
  const payload = await client.request(
    "/aweme/v1/web/mix/aweme/",
    {
      ...client.query(),
      count: PAGE_SIZE,
      cursor,
      mix_id: mixId,
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
    const id = readIdentifier(aweme.aweme_id_str, aweme.aweme_id, aweme.awemeId);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const author = readRecord(aweme.author);
    const statistics = {
      ...readRecord(aweme.statistics_v2),
      ...readRecord(aweme.statistics),
    };
    const authorName = readAuthorName(author);
    const authorId = readIdentifier(author.sec_uid, author.secUid, author.uid);
    const authorKey = authorId || authorName;
    upsertAuthor(authors, authorKey, {
      avatarUrl: readDouyinAvatarUrl(author),
      followerCount: readInteger(author.follower_count ?? author.followerCount),
      id: authorId,
      name: authorName,
      signature: cleanText(readString(author.signature)) || "",
      uniqueId: cleanText(readString(author.unique_id) || readString(author.short_id)) || "",
      workCount: readInteger(author.aweme_count ?? author.awemeCount),
    });
    videos.push({
      author: authorName,
      authorId,
      commentCount: readInteger(statistics.comment_count ?? statistics.commentCount),
      coverUrl: readAwemeCoverUrl(aweme),
      favoriteCount: readInteger(statistics.collect_count ?? statistics.collectCount),
      isFollowing: readInteger(author.follow_status ?? author.followStatus) > 0,
      likeCount: readInteger(statistics.digg_count ?? statistics.diggCount),
      publishedAt: readInteger(aweme.create_time ?? aweme.createTime),
      title: readTitle(aweme),
      url: new URL(`/video/${encodeURIComponent(id)}`, DOUYIN_BASE_URL).toString(),
    });
    if (videos.length >= maxVideos) {
      break;
    }
  }
}

function mergeAuthors(
  target: Map<string, DouyinFavoriteAuthor>,
  source: Map<string, DouyinFavoriteAuthor>,
): void {
  for (const [key, author] of source) {
    upsertAuthor(target, key, author);
  }
}

function upsertAuthor(
  authors: Map<string, DouyinFavoriteAuthor>,
  key: string,
  author: DouyinFavoriteAuthor,
): void {
  for (const [existingKey, existing] of authors) {
    if ((author.id && existing.id === author.id) || existing.name === author.name) {
      authors.set(existingKey, {
        avatarUrl: existing.avatarUrl || author.avatarUrl,
        followerCount: existing.followerCount || author.followerCount,
        id: existing.id || author.id,
        name: existing.name,
        signature: existing.signature || author.signature,
        uniqueId: existing.uniqueId || author.uniqueId,
        workCount: existing.workCount || author.workCount,
      });
      return;
    }
  }
  authors.set(key, author);
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
  const info = readRecord(item.collects_info);
  return readIdentifier(
    item.collects_id_str,
    item.collects_id,
    item.id,
    info.collects_id_str,
    info.collects_id,
  );
}

function unwrapMix(value: unknown): Record<string, unknown> {
  const item = readRecord(value);
  const info = readRecord(item.mix_info);
  return Object.keys(info).length > 0 ? { ...item, ...info } : item;
}

function readAweme(value: unknown): Record<string, unknown> {
  const item = readRecord(value);
  const nested = readRecord(item.aweme_info ?? item.aweme ?? item.aweme_detail);
  return Object.keys(nested).length > 0 ? nested : item;
}

function readAwemeCoverUrl(aweme: Record<string, unknown>): string {
  const video = readRecord(aweme.video);
  const images = Array.isArray(aweme.images) ? aweme.images : [];
  const imagePost = readRecord(aweme.image_post_info);
  const postImages = Array.isArray(imagePost.images) ? imagePost.images : [];
  return readMediaUrl(
    video.cover,
    video.origin_cover,
    video.dynamic_cover,
    images[0],
    postImages[0],
  );
}

function readMixCoverUrl(mix: Record<string, unknown>): string {
  return readMediaUrl(
    mix.cover_url,
    mix.cover,
    mix.mix_cover,
    mix.mix_pic,
    mix.pic_url,
    mix.image_url,
  );
}

function readMediaUrl(...values: unknown[]): string {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const nested = readMediaUrl(...value);
      if (nested) {
        return nested;
      }
      continue;
    }
    const source = readRecord(value);
    if (Object.keys(source).length === 0) {
      continue;
    }
    const nested = readMediaUrl(
      source.url_list,
      source.urlList,
      source.url,
      source.display_image,
      source.cover,
    );
    if (nested) {
      return nested;
    }
  }
  return "";
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

function readIdentifier(...values: unknown[]): string {
  for (const value of values) {
    const identifier = readString(value);
    if (identifier) {
      return identifier;
    }
  }
  const numeric = values.find(
    (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  );
  return numeric === undefined ? "" : String(numeric);
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
