import { createDouyinWebClient } from "@/lib/douyin/web-client";
import { readDouyinCredentialState } from "@/lib/douyin/account";
import { readUsableBilibiliCookie } from "@/lib/bilibili/account";
import { requestBilibiliJson, requestBilibiliWbiJson } from "@/lib/bilibili/client";
import { readUserSetting } from "@/lib/user-settings";
import { resolveMediaUrl } from "@/lib/media/redirect";
import { openApiPlatformRequestPolicy } from "@/lib/open-api/platform-request-policy";
import {
  videoUrl,
  type AuthorVideoPage,
  type BatchPlatform,
} from "./contracts";
import {
  createAuthorVideoMatcher,
  DEFAULT_VIDEO_FILTERS,
  extractHashtags,
  normalizeTags,
  type AuthorVideoFilters,
} from "./video-filters";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export async function resolveAuthorId(
  platform: BatchPlatform,
  input: string,
): Promise<string> {
  if (platform === "bilibili" && /^\d{1,20}$/.test(input)) return input;
  if (platform === "douyin" && /^[\w-]{20,200}$/.test(input)) return input;
  const extracted = input.match(/https?:\/\/[^\s]+/)?.[0];
  if (!extracted) throw new Error("请填写用户主页链接或用户标识。");
  const origin = new URL(extracted);
  const supported =
    platform === "douyin"
      ? origin.hostname === "douyin.com" ||
        origin.hostname.endsWith(".douyin.com")
      : origin.hostname === "space.bilibili.com" ||
        origin.hostname === "b23.tv";
  if (!supported || origin.username || origin.password || origin.port)
    throw new Error("请填写对应平台的用户主页链接。");
  if (
    platform === "bilibili" &&
    origin.hostname === "space.bilibili.com" &&
    /^\/\d{1,20}(?:\/|$)/.test(origin.pathname)
  )
    return origin.pathname.split("/")[1];
  const profile = /^\/user\/([\w-]{20,200})(?:\/|$)/.exec(origin.pathname);
  if (platform === "douyin" && profile) return profile[1];
  // Existing redirect resolver restricts the final source to supported platforms.
  const resolved = await resolveMediaUrl(input);
  const url = new URL(resolved.finalUrl);
  if (
    platform === "bilibili" &&
    url.hostname === "space.bilibili.com" &&
    /^\/\d{1,20}(?:\/|$)/.test(url.pathname)
  )
    return url.pathname.split("/")[1];
  const match = /^\/user\/([\w-]{20,200})(?:\/|$)/.exec(url.pathname);
  if (
    platform === "douyin" &&
    (url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com")) &&
    match
  )
    return match[1];
  throw new Error(
    "请填写对应平台的用户主页链接，Bilibili 也支持 UID，抖音也支持 sec_uid。",
  );
}

export async function fetchAuthorVideos(input: {
  platform: BatchPlatform;
  authorId: string;
  cursor?: string;
  userId: string;
  signal?: AbortSignal;
  filters?: AuthorVideoFilters;
}): Promise<AuthorVideoPage> {
  input.signal?.throwIfAborted();
  const filters = input.filters ?? DEFAULT_VIDEO_FILTERS;
  const matches = createAuthorVideoMatcher(filters);
  const cursor = input.cursor ?? (input.platform === "douyin" ? "0" : "1");
  if (!/^\d{1,20}$/.test(cursor)) throw new Error("分页参数无效。");
  if (input.platform === "douyin") {
    if (!/^[\w-]{20,200}$/.test(input.authorId))
      throw new Error("抖音用户标识无效。");
    const credential = await readDouyinCredentialState(input.userId);
    if (credential.status !== "valid")
      throw new Error("请先在设置中保存并验证抖音访问凭证。");
    const client = createDouyinWebClient(credential.cookie, { signal: input.signal });
    const payload = await client.request(
      "/aweme/v1/web/aweme/post/",
      {
        ...client.query(),
        sec_user_id: input.authorId,
        max_cursor: cursor,
        count: 18,
        locate_query: "false",
        show_live_replay_strategy: "1",
        need_time_list: "1",
        time_list_query: "0",
        whale_cut_token: "",
        cut_version: "1",
        publish_video_strategy_type: "2",
      },
      3,
    );
    if (!("has_more" in payload))
      throw new Error("抖音响应缺少分页状态，无法确认作品列表是否完整。");
    const items = list(payload.aweme_list).map(record);
    const next = String(payload.max_cursor ?? "0");
    const hasMore = payload.has_more === true || Number(payload.has_more) === 1;
    if (hasMore && next === cursor)
      throw new Error(
        "抖音分页游标未前进，请稍后重试；已获取的视频可继续使用。",
      );
    const videos = items
      .filter((item) => !list(item.images).length && text(item.aweme_id))
      .map((item) => ({
        id: text(item.aweme_id),
        title: text(item.desc) || `视频 ${text(item.aweme_id)}`,
        coverUrl: text(list(record(record(item.video).cover).url_list)[0]),
        durationSeconds: Number(record(item.video).duration ?? item.duration ?? 0) / 1000,
        publishedAt: Number(item.create_time ?? 0) * 1000,
        tags: normalizeTags([
          ...list(item.text_extra).flatMap((extra) => [text(record(extra).hashtag_name), text(record(extra).tag_name)]),
          ...list(item.cha_list).flatMap((tag) => [text(record(tag).cha_name), text(record(tag).name)]),
          ...extractHashtags(text(item.desc)),
        ]),
      }));
    return {
      authorId: input.authorId,
      authorName: text(record(items[0]?.author).nickname),
      cursor: hasMore ? next : null,
      scannedCount: videos.length,
      videos: videos.filter(matches),
    };
  }
  if (!/^\d{1,20}$/.test(input.authorId))
    throw new Error("Bilibili UID 无效。");
  const policy = openApiPlatformRequestPolicy.forUser(input.userId);
  const cookie = readUsableBilibiliCookie(
    await readUserSetting(input.userId, "bilibili"),
  );
  const payload = await requestBilibiliWbiJson(
    "https://api.bilibili.com/x/space/wbi/arc/search",
    {
      mid: input.authorId,
      pn: cursor,
      ps: 30,
      tid: 0,
      order: "pubdate",
      index: 0,
      keyword: "",
      platform: "web",
      web_location: "333.1387",
      order_avoided: "true",
    },
    cookie,
    policy,
    input.signal,
  );
  const data = record(payload.data);
  if (!Array.isArray(record(data.list).vlist))
    throw new Error("Bilibili 作品列表响应格式异常，请稍后重试。");
  const items = list(record(data.list).vlist).map(record);
  const total = Number(record(data.page).count);
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error("Bilibili 响应缺少有效作品总数，无法确认列表是否完整。");
  if (!items.length && (Number(cursor) - 1) * 30 < total)
    throw new Error("Bilibili 返回了不完整分页，请稍后重试。");
  const videos = items
      .filter((item) => text(item.bvid))
      .map((item) => {
        const id = text(item.bvid);
        videoUrl("bilibili", id);
        return {
          id,
          title: text(item.title) || id,
          coverUrl: text(item.pic).replace(/^\/\//, "https://"),
          durationSeconds: parseDuration(text(item.length)),
          publishedAt: Number(item.created ?? 0) * 1000,
          tags: normalizeTags(extractHashtags(text(item.title))),
        };
      });
  const candidates = videos.filter(createAuthorVideoMatcher(filters, true));
  if (filters.tags.length) {
    for (const video of candidates) {
      input.signal?.throwIfAborted();
      const payload = await requestBilibiliJson(
        `https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(video.id)}`,
        cookie,
        policy,
        input.signal,
      );
      if (!Array.isArray(payload.data)) throw new Error("Bilibili 标签响应格式异常，请稍后重试。");
      video.tags = normalizeTags(payload.data.map((tag) => text(record(tag).tag_name)));
    }
  }
  return {
    authorId: input.authorId,
    authorName: text(items[0]?.author),
    total,
    cursor: Number(cursor) * 30 < total ? String(Number(cursor) + 1) : null,
    scannedCount: videos.length,
    videos: candidates.filter(matches),
  };
}

function parseDuration(value: string): number {
  return value
    .split(":")
    .reduce((seconds, part) => seconds * 60 + Number(part || 0), 0);
}
