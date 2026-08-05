import { fetchWithRetry } from "@/lib/http/retry";

const FAVORITE_FOLDER_URL = "https://api.bilibili.com/x/v3/fav/folder/created/list-all";
const COLLECTED_FOLDER_URL = "https://api.bilibili.com/x/v3/fav/folder/collected/list";
const FAVORITE_RESOURCE_URL = "https://api.bilibili.com/x/v3/fav/resource/list";
const COLLECTION_RESOURCE_URL = "https://api.bilibili.com/x/polymer/web-space/seasons_archives_list";
const VIDEO_VIEW_URL = "https://api.bilibili.com/x/web-interface/view";
const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const PAGE_SIZE = 40;
const COLLECTION_PAGE_SIZE = 30;
const MAX_GROUPS = 100;
const MAX_WORKS_PER_GROUP = 5_000;
const FETCH_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 15_000;

type RecordValue = Record<string, unknown>;
type AsyncLimiter = <T>(task: () => Promise<T>) => Promise<T>;

type BilibiliFavoriteSettings = { cookie: string };

type BilibiliFavoriteVideo = {
  author: string;
  authorAvatarUrl: string;
  authorId: string;
  bvid?: string;
  coverUrl: string;
  isAvailable: boolean;
  isFollowing: boolean;
  platform: "bilibili";
  publishedAt?: number;
  title: string;
  url: string;
};

type BilibiliFavoriteFolder = {
  id: string;
  name: string;
  total: number;
  url: string;
  works: BilibiliFavoriteVideo[];
};

type BilibiliFavoriteMix = {
  coverUrl: string;
  id: string;
  name: string;
  playCount: number;
  total: number;
  url: string;
  works: BilibiliFavoriteVideo[];
};

type BilibiliFavoritesSnapshot = {
  authors: [];
  folders: BilibiliFavoriteFolder[];
  mixes: BilibiliFavoriteMix[];
  videos: BilibiliFavoriteVideo[];
};

export class BilibiliFavoriteError extends Error {
  constructor(message: string, readonly code = "BILIBILI_FAVORITES_ERROR") {
    super(message);
    this.name = "BilibiliFavoriteError";
  }
}

export async function collectBilibiliFavorites(
  settings: BilibiliFavoriteSettings,
): Promise<BilibiliFavoritesSnapshot> {
  const headers = {
    accept: "application/json",
    cookie: settings.cookie,
    referer: "https://www.bilibili.com/",
  };
  const nav = await requestJson(new URL(NAV_URL), headers);
  const mid = readId(readRecord(nav.data)?.mid);
  if (!mid) {
    throw new BilibiliFavoriteError("Bilibili 登录信息中缺少用户 ID。", "LOGIN_REQUIRED");
  }

  const [created, collected] = await Promise.all([
    readGroupList(FAVORITE_FOLDER_URL, mid, headers),
    readGroupList(COLLECTED_FOLDER_URL, mid, headers),
  ]);
  const limiter = createLimiter(FETCH_CONCURRENCY);
  const [folders, mixes] = await Promise.all([
    expandFolders(created, headers, limiter),
    expandMixes(collected, mid, headers, limiter),
  ]);
  return { authors: [], folders, mixes, videos: [] };
}

async function readGroupList(
  endpoint: string,
  mid: string,
  headers: Record<string, string>,
): Promise<RecordValue[]> {
  const url = new URL(endpoint);
  url.searchParams.set("up_mid", mid);
  url.searchParams.set("pn", "1");
  url.searchParams.set("ps", "50");
  url.searchParams.set("platform", "web");
  url.searchParams.set("web_location", "333.1387");
  const data = readRecord((await requestJson(url, headers)).data);
  return readArray(data?.list).slice(0, MAX_GROUPS);
}

async function expandFolders(
  entries: RecordValue[],
  headers: Record<string, string>,
  limiter: AsyncLimiter,
): Promise<BilibiliFavoriteFolder[]> {
  return (await Promise.all(entries.map((entry) => limiter(async () => {
    const id = readId(entry.id);
    if (!id) return null;
    const works = await readFavoriteResources(id, headers).catch(() => []);
    const ownerId = readId(entry.mid) ?? "";
    return {
      id,
      name: readString(entry.title) ?? "未命名收藏夹",
      total: Math.max(readNumber(entry.media_count), works.length),
      url: `https://space.bilibili.com/${ownerId}/favlist?fid=${id}`,
      works,
    } satisfies BilibiliFavoriteFolder;
  })))).filter((group): group is BilibiliFavoriteFolder => group !== null);
}

async function expandMixes(
  entries: RecordValue[],
  mid: string,
  headers: Record<string, string>,
  limiter: AsyncLimiter,
): Promise<BilibiliFavoriteMix[]> {
  return (await Promise.all(entries.map((entry) => limiter(async () => {
    const id = readId(entry.id);
    if (!id) return null;
    const collection = await readCollectionResources(mid, id, headers).catch(() => null);
    const name = readString(entry.title) ?? "未命名合集";
    if (!collection) return null;
    if (!collection.archives.length && /合集已失效/u.test(name)) return null;
    const firstAvailable = collection.archives.find((work) => work.bvid);
    const author = firstAvailable?.author !== "未知作者" && firstAvailable?.authorAvatarUrl
      ? undefined
      : await readCollectionAuthor(firstAvailable?.bvid, headers);
    const works = author
      ? collection.archives.map((work) => ({
          ...work,
          author: readString(author.name) ?? work.author,
          authorAvatarUrl: normalizeImageUrl(readString(author.face)) || work.authorAvatarUrl,
          authorId: readId(author.mid) ?? work.authorId,
        }))
      : collection.archives;
    return {
      coverUrl: normalizeImageUrl(readString(entry.cover)),
      id,
      name,
      playCount: 0,
      total: Math.max(readNumber(entry.media_count), collection.total, collection.archives.length),
      url: `https://space.bilibili.com/${mid}/lists/${id}?type=season`,
      works,
    } satisfies BilibiliFavoriteMix;
  })))).filter((group): group is BilibiliFavoriteMix => group !== null);
}

async function readFavoriteResources(
  mediaId: string,
  headers: Record<string, string>,
): Promise<BilibiliFavoriteVideo[]> {
  const result: BilibiliFavoriteVideo[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  while (result.length < total && result.length < MAX_WORKS_PER_GROUP) {
    const url = new URL(FAVORITE_RESOURCE_URL);
    url.searchParams.set("media_id", mediaId);
    url.searchParams.set("pn", String(page));
    url.searchParams.set("ps", String(PAGE_SIZE));
    url.searchParams.set("keyword", "");
    url.searchParams.set("order", "mtime");
    url.searchParams.set("type", "0");
    url.searchParams.set("tid", "0");
    url.searchParams.set("platform", "web");
    url.searchParams.set("web_location", "333.1387");
    const data = readRecord((await requestJson(url, headers)).data);
    const info = readRecord(data?.info);
    total = readNumber(info?.media_count);
    const items = readArray(data?.medias);
    if (!items.length) break;
    result.push(...items.map(toVideo));
    if (items.length < PAGE_SIZE) break;
    page += 1;
  }
  return result.slice(0, MAX_WORKS_PER_GROUP);
}

async function readCollectionAuthor(
  bvid: string | undefined,
  headers: Record<string, string>,
): Promise<RecordValue | undefined> {
  if (!bvid) return undefined;
  const url = new URL(VIDEO_VIEW_URL);
  url.searchParams.set("bvid", bvid);
  try {
    const payload = await requestJson(url, headers);
    return readRecord(readRecord(payload.data)?.owner);
  } catch {
    return undefined;
  }
}

async function readCollectionResources(
  mid: string,
  seasonId: string,
  headers: Record<string, string>,
): Promise<{ archives: BilibiliFavoriteVideo[]; total: number }> {
  const archives: BilibiliFavoriteVideo[] = [];
  let pageNumber = 1;
  let total = Number.POSITIVE_INFINITY;
  while (archives.length < total && archives.length < MAX_WORKS_PER_GROUP) {
    const url = new URL(COLLECTION_RESOURCE_URL);
    url.searchParams.set("mid", mid);
    url.searchParams.set("season_id", seasonId);
    url.searchParams.set("sort_reverse", "false");
    url.searchParams.set("page_size", String(COLLECTION_PAGE_SIZE));
    url.searchParams.set("page_num", String(pageNumber));
    url.searchParams.set("web_location", "333.1387");
    const data = readRecord((await requestJson(url, headers)).data);
    const page = readRecord(data?.page);
    total = readNumber(page?.total);
    const items = readArray(data?.archives);
    if (!items.length) break;
    archives.push(...items.map(toVideo));
    if (items.length < COLLECTION_PAGE_SIZE) break;
    pageNumber += 1;
  }
  return { archives: archives.slice(0, MAX_WORKS_PER_GROUP), total };
}

function toVideo(value: RecordValue): BilibiliFavoriteVideo {
  const bvid = readString(value.bvid);
  const owner = readRecord(value.upper) ?? readRecord(value.owner);
  const title = readString(value.title) ?? (bvid ? bvid : "已失效视频");
  return {
    author: readString(owner?.name) ?? "未知作者",
    authorAvatarUrl: normalizeImageUrl(readString(owner?.face)),
    authorId: readId(owner?.mid) ?? "",
    bvid: bvid ?? undefined,
    coverUrl: normalizeImageUrl(readString(value.cover ?? value.pic)),
    isAvailable: Boolean(bvid) && !/失效/u.test(readString(value.title) ?? ""),
    isFollowing: false,
    platform: "bilibili",
    publishedAt: readNumber(value.pubtime ?? value.pubdate),
    title,
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : "",
  };
}

async function requestJson(url: URL, headers: Record<string, string>): Promise<RecordValue> {
  let response: Response;
  try {
    response = await fetchWithRetry(url.toString(), {
      cache: "no-store",
      headers: { ...headers, "user-agent": "Mozilla/5.0" },
      retry: { timeoutMs: REQUEST_TIMEOUT_MS },
    });
  } catch {
    throw new BilibiliFavoriteError("Bilibili 收藏接口请求失败。", "UPSTREAM_ERROR");
  }
  const payload = readRecord(await response.json().catch(() => null));
  if (!response.ok || !payload) {
    throw new BilibiliFavoriteError("Bilibili 收藏接口响应异常。", "UPSTREAM_ERROR");
  }
  if (payload.code !== 0) {
    if (payload.code === -101) {
      throw new BilibiliFavoriteError("Bilibili 登录凭证已失效，请重新登录。", "LOGIN_REQUIRED");
    }
    throw new BilibiliFavoriteError(readString(payload.message) ?? "Bilibili 收藏接口返回错误。", String(payload.code));
  }
  return payload;
}

function createLimiter(limit: number): AsyncLimiter {
  let active = 0;
  const pending: (() => void)[] = [];
  return async <T>(task: () => Promise<T>) => {
    if (active >= limit) await new Promise<void>((resolve) => pending.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      pending.shift()?.();
    }
  };
}

function readRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function readArray(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const record = readRecord(item);
    return record ? [record] : [];
  }) : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readId(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function normalizeImageUrl(value: string | undefined): string {
  return value?.startsWith("//") ? `https:${value}` : value ?? "";
}