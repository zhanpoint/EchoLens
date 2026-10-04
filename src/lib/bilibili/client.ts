import { createHash } from "node:crypto";
import { fetchWithRetry } from "@/lib/http/retry";
import {
  DEFAULT_BILIBILI_AUDIO_QUALITY,
  DEFAULT_BILIBILI_VIDEO_CODEC,
  DEFAULT_BILIBILI_VIDEO_QUALITY,
  type BilibiliAudioQuality,
  type BilibiliVideoCodec,
  type BilibiliVideoQuality,
} from "@/lib/download-settings";
import { resolveMediaUrl } from "@/lib/media/redirect";
import type { OpenApiPlatformRequestPolicy } from "@/lib/open-api/platform-request-policy";
import { extractHttpUrl, parseHttpUrl } from "@/lib/media/source";

const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const VIEW_URL = "https://api.bilibili.com/x/web-interface/wbi/view";
const PLAY_URL = "https://api.bilibili.com/x/player/wbi/playurl";
const SPI_URL = "https://api.bilibili.com/x/frontend/finger/spi";
const REFERER = "https://www.bilibili.com/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
] as const;
const BVID_PATTERN = /^BV[\p{L}\p{N}]+$/iu;
const BVID_IN_PATH_PATTERN = /\/video\/(BV[\p{L}\p{N}]+)(?:\/|$)/iu;

export type {
  BilibiliAudioQuality,
  BilibiliVideoCodec,
  BilibiliVideoQuality,
} from "@/lib/download-settings";

export type BilibiliPage = {
  cid: number;
  durationSeconds: number;
  page: number;
  part: string;
};

export type BilibiliUgcSeason = Record<string, unknown>;

export type BilibiliWorkIdentity = {
  aid: number;
  bvid: string;
  cid: number;
  finalUrl: string;
  id: string;
  inputUrl: string;
  kind: "video";
  page: number;
  pages: BilibiliPage[];
  source: "bilibili";
  ugcSeason?: BilibiliUgcSeason;
};

export type BilibiliWorkMetadata = {
  aid: number;
  authorAvatarUrls: string[];
  authorName: string;
  authorUrl?: string;
  bvid: string;
  caption: string;
  cid: number;
  coverUrls: string[];
  durationSeconds: number;
  page: number;
  pages: BilibiliPage[];
  ugcSeason?: BilibiliUgcSeason;
};

export type BilibiliResolvedWork = BilibiliWorkIdentity & {
  authorAvatarUrl?: string;
  authorName?: string;
  authorUrl?: string;
  caption: string;
  durationSeconds?: number;
};

export type BilibiliMediaStream = {
  bandwidth: number;
  codecId?: number;
  height?: number;
  id: number;
  urls: string[];
};

export type BilibiliDashSelection = {
  audio: BilibiliMediaStream;
  video: BilibiliMediaStream;
};

export class BilibiliApiError extends Error {
  constructor(message: string, readonly code = "BILIBILI_API_ERROR") {
    super(message);
    this.name = "BilibiliApiError";
  }
}

type WbiSession = { cookie: string; imgKey: string; subKey: string };

export function buildBilibiliWorkId(bvid: string, cid: number): string {
  return `${normalizeBvid(bvid)}:${cid}`;
}

export function isBilibiliBvid(value: string): boolean {
  return BVID_PATTERN.test(value.trim());
}

export async function resolveBilibiliWork(
  input: string,
  cookie = "",
  options: { finalUrl?: string; requestPolicy?: OpenApiPlatformRequestPolicy } = {},
): Promise<{ metadata: BilibiliWorkMetadata; work: BilibiliResolvedWork }> {
  const normalizedInput = readBilibiliInput(input);
  const inputUrl = normalizedInput.inputUrl;
  const canonicalInput = options.finalUrl ?? normalizedInput.finalUrl ?? await resolveBilibiliFinalUrl(inputUrl);
  const identity = parseBilibiliIdentity(canonicalInput);
  const view = await requestWbiJsonAnonymousFirst(VIEW_URL, { bvid: identity.bvid }, cookie, options.requestPolicy);
  const data = asRecord(view.data);
  if (!data) throw invalidViewData();

  const aid = readPositiveInteger(data.aid);
  const resolvedBvid = readString(data.bvid);
  const pages = readPages(data.pages);
  const fallbackPage = readPageData(data);
  const availablePages = pages.length ? pages : fallbackPage ? [fallbackPage] : [];
  const selectedPage = availablePages.find(({ page }) => page === identity.page);
  if (!aid || !resolvedBvid || !selectedPage) throw invalidViewData();

  const owner = asRecord(data.owner);
  const authorName = readString(owner?.name);
  const caption = selectedPage.part || readString(data.title);
  const durationSeconds = selectedPage.durationSeconds || readPositiveNumber(data.duration);
  const cover = normalizeImageUrl(readString(data.pic));
  const avatar = normalizeImageUrl(readString(owner?.face));
  if (!authorName || !caption || !durationSeconds || !cover) throw invalidViewData();

  const selectedPageNumber = selectedPage.page;
  const finalUrl = new URL(`/video/${resolvedBvid}`, "https://www.bilibili.com");
  if (selectedPageNumber > 1) finalUrl.searchParams.set("p", String(selectedPageNumber));
  const authorId = readPositiveInteger(owner?.mid);
  const authorUrl = authorId ? `https://space.bilibili.com/${authorId}` : undefined;
  const ugcSeason = asRecord(data.ugc_season);
  const metadata: BilibiliWorkMetadata = {
    aid,
    authorAvatarUrls: avatar ? [avatar] : [],
    authorName,
    authorUrl,
    bvid: resolvedBvid,
    caption,
    cid: selectedPage.cid,
    coverUrls: [cover],
    durationSeconds,
    page: selectedPageNumber,
    pages: availablePages,
    ...(ugcSeason ? { ugcSeason } : {}),
  };
  const workId = buildBilibiliWorkId(metadata.bvid, metadata.cid);
  return {
    metadata,
    work: {
      aid,
      authorAvatarUrl: avatar,
      authorName,
      authorUrl,
      bvid: resolvedBvid,
      caption,
      cid: selectedPage.cid,
      durationSeconds,
      finalUrl: finalUrl.toString(),
      id: workId,
      inputUrl,
      kind: "video",
      page: selectedPageNumber,
      pages: availablePages,
      source: "bilibili",
      ...(ugcSeason ? { ugcSeason } : {}),
    },
  };
}

export async function getBilibiliDashSelection(input: {
  audioQuality?: BilibiliAudioQuality;
  bvid: string;
  cid: number;
  codec?: BilibiliVideoCodec;
  cookie?: string;
  requestPolicy?: OpenApiPlatformRequestPolicy;
  videoQuality?: BilibiliVideoQuality;
}): Promise<BilibiliDashSelection> {
  const preferred = {
    audioQuality: input.audioQuality ?? DEFAULT_BILIBILI_AUDIO_QUALITY,
    codec: input.codec ?? DEFAULT_BILIBILI_VIDEO_CODEC,
    videoQuality: input.videoQuality ?? DEFAULT_BILIBILI_VIDEO_QUALITY,
  };
  const anonymousSession = await getWbiSession("", input.requestPolicy);
  const anonymousPayload = await requestDashPayload(input, preferred, anonymousSession, input.requestPolicy);
  const anonymousSelection = selectDashStreams(anonymousPayload, preferred, true);
  if (anonymousSelection) return anonymousSelection;

  const cookie = input.cookie?.trim() ?? "";
  if (cookie) {
    const authenticatedSession = await getWbiSession(cookie, input.requestPolicy);
    const authenticatedPayload = await requestDashPayload(input, preferred, authenticatedSession, input.requestPolicy);
    const authenticatedSelection = selectDashStreams(authenticatedPayload, preferred, true);
    if (authenticatedSelection) return authenticatedSelection;
  }

  const fallback = {
    audioQuality: DEFAULT_BILIBILI_AUDIO_QUALITY,
    codec: DEFAULT_BILIBILI_VIDEO_CODEC,
    videoQuality: DEFAULT_BILIBILI_VIDEO_QUALITY,
  };
  const fallbackPayload = isDefaultDashOptions(preferred)
    ? anonymousPayload
    : await requestDashPayload(input, fallback, anonymousSession, input.requestPolicy);
  const fallbackSelection = selectDashStreams(fallbackPayload, fallback, false);
  if (fallbackSelection) return fallbackSelection;
  throw new BilibiliApiError("Bilibili DASH 播放地址不可用。", "DASH_UNAVAILABLE");
}

async function requestDashPayload(
  input: Pick<Parameters<typeof getBilibiliDashSelection>[0], "bvid" | "cid">,
  options: {
    audioQuality: BilibiliAudioQuality;
    codec: BilibiliVideoCodec;
    videoQuality: BilibiliVideoQuality;
  },
  session: WbiSession,
  requestPolicy?: OpenApiPlatformRequestPolicy,
): Promise<Record<string, unknown>> {
  return await requestWbiJsonWithSession(PLAY_URL, {
    bvid: input.bvid,
    cid: input.cid,
    fnval: 4048,
    fnver: 0,
    fourk: 1,
    qn: qualityToQn(options.videoQuality),
  }, session, requestPolicy);
}

function selectDashStreams(
  payload: Record<string, unknown>,
  options: {
    audioQuality: BilibiliAudioQuality;
    codec: BilibiliVideoCodec;
    videoQuality: BilibiliVideoQuality;
  },
  strict: boolean,
): BilibiliDashSelection | null {
  const dash = asRecord(asRecord(payload.data)?.dash);
  const videos = readStreams(dash?.video);
  const standardAudio = readStreams(dash?.audio);
  const dolby = readStreams(asRecord(dash?.dolby)?.audio).map((stream) => ({ ...stream, id: 30250 }));
  const flacValue = asRecord(dash?.flac)?.audio;
  const flac = readStreams(flacValue ? [{ ...flacValue, id: 30251 }] : []);
  const audio = chooseAudio([...standardAudio, ...dolby, ...flac], options.audioQuality);
  const video = chooseVideo(videos, options.codec, options.videoQuality, strict);
  return video && audio ? { audio, video } : null;
}

function isDefaultDashOptions(options: {
  audioQuality: BilibiliAudioQuality;
  codec: BilibiliVideoCodec;
  videoQuality: BilibiliVideoQuality;
}): boolean {
  return options.audioQuality === DEFAULT_BILIBILI_AUDIO_QUALITY &&
    options.codec === DEFAULT_BILIBILI_VIDEO_CODEC &&
    options.videoQuality === DEFAULT_BILIBILI_VIDEO_QUALITY;
}

export async function validateBilibiliCookie(cookie: string): Promise<{
  isLogin: boolean;
  username?: string;
}> {
  const payload = await requestJson(NAV_URL, cookie);
  const data = asRecord(payload.data);
  return {
    isLogin: data?.isLogin === true,
    username: readString(data?.uname),
  };
}

function readBilibiliInput(input: string): { finalUrl?: string; inputUrl: string } {
  const extracted = extractHttpUrl(input);
  if (extracted) return { inputUrl: extracted.value };

  const candidate = input.trim();
  if (BVID_PATTERN.test(candidate)) {
    const canonicalUrl = `https://www.bilibili.com/video/${normalizeBvid(candidate)}`;
    return { finalUrl: canonicalUrl, inputUrl: canonicalUrl };
  }

  throw new BilibiliApiError("请输入有效的 Bilibili 视频分享链接或 BV 号。", "INVALID_LINK");
}

async function resolveBilibiliFinalUrl(value: string): Promise<string> {
  try {
    const resolved = await resolveMediaUrl(value);
    if (resolved.source !== "bilibili") {
      throw new BilibiliApiError("链接最终未指向 Bilibili 视频。", "UNSUPPORTED_SOURCE");
    }
    return resolved.finalUrl;
  } catch (error) {
    if (error instanceof BilibiliApiError) throw error;
    throw new BilibiliApiError("Bilibili 链接重定向失败，请稍后重试。", "REDIRECT_FAILED");
  }
}

function parseBilibiliIdentity(value: string): { bvid: string; page: number } {
  const url = parseHttpUrl(value);
  const match = url?.pathname.match(BVID_IN_PATH_PATTERN);
  if (!url || !match) {
    throw new BilibiliApiError("请输入有效的 Bilibili 投稿视频链接。", "INVALID_LINK");
  }

  const page = Number(url.searchParams.get("p") ?? 1);
  return {
    bvid: normalizeBvid(match[1]),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

function normalizeBvid(value: string): string {
  return `BV${value.slice(2)}`;
}

function readPages(value: unknown): BilibiliPage[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const page = readPageData(asRecord(item));
        return page ? [page] : [];
      })
    : [];
}

function readPageData(value: Record<string, unknown> | undefined): BilibiliPage | null {
  const cid = readPositiveInteger(value?.cid);
  const durationSeconds = readPositiveNumber(value?.duration);
  const page = readPositiveInteger(value?.page) ?? 1;
  const part = readString(value?.part ?? value?.title) ?? "";
  return cid && durationSeconds
    ? { cid, durationSeconds, page, part }
    : null;
}

function invalidViewData(): BilibiliApiError {
  return new BilibiliApiError("Bilibili 作品信息不完整。", "INVALID_VIEW_DATA");
}

async function requestWbiJsonAnonymousFirst(
  endpoint: string,
  params: Record<string, string | number>,
  cookie: string,
  requestPolicy?: OpenApiPlatformRequestPolicy,
): Promise<Record<string, unknown>> {
  try {
    return await requestBilibiliWbiJson(endpoint, params, "", requestPolicy);
  } catch (error) {
    if (!cookie.trim()) throw error;
    return await requestBilibiliWbiJson(endpoint, params, cookie, requestPolicy);
  }
}

export async function requestBilibiliWbiJson(
  endpoint: string,
  params: Record<string, string | number>,
  cookie: string,
  requestPolicy?: OpenApiPlatformRequestPolicy,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return await requestWbiJsonWithSession(endpoint, params, await getWbiSession(cookie, requestPolicy, signal), requestPolicy, signal);
}

async function requestWbiJsonWithSession(
  endpoint: string,
  params: Record<string, string | number>,
  session: WbiSession,
  requestPolicy?: OpenApiPlatformRequestPolicy,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const query = signWbi(params, session);
  return await requestJson(`${endpoint}?${query}`, session.cookie, requestPolicy, signal);
}

async function getWbiSession(
  cookie: string,
  requestPolicy?: OpenApiPlatformRequestPolicy,
  signal?: AbortSignal,
): Promise<WbiSession> {
  let effectiveCookie = cookie.trim();
  let payload = await requestPayload(NAV_URL, effectiveCookie, requestPolicy, signal);
  let keys = readWbiKeys(payload);
  if (!keys && !effectiveCookie) {
    const spi = await requestJson(SPI_URL, "", requestPolicy, signal);
    const data = asRecord(spi.data);
    const buvid3 = readString(data?.b_3);
    const buvid4 = readString(data?.b_4);
    effectiveCookie = [buvid3 ? `buvid3=${buvid3}` : "", buvid4 ? `buvid4=${buvid4}` : ""]
      .filter(Boolean)
      .join("; ");
    if (effectiveCookie) {
      payload = await requestPayload(NAV_URL, effectiveCookie, requestPolicy, signal);
      keys = readWbiKeys(payload);
    }
  }
  if (!keys) {
    if (payload.code !== 0) assertSuccessfulPayload(payload);
    throw new BilibiliApiError("无法获取 Bilibili WBI 密钥。", "WBI_KEY_UNAVAILABLE");
  }
  return { cookie: effectiveCookie, ...keys };
}

function readWbiKeys(payload: Record<string, unknown>): Pick<WbiSession, "imgKey" | "subKey"> | null {
  const wbiImg = asRecord(asRecord(payload.data)?.wbi_img);
  const imgKey = fileStem(readString(wbiImg?.img_url));
  const subKey = fileStem(readString(wbiImg?.sub_url));
  return imgKey && subKey ? { imgKey, subKey } : null;
}

function signWbi(params: Record<string, string | number>, keys: Pick<WbiSession, "imgKey" | "subKey">): string {
  const original = `${keys.imgKey}${keys.subKey}`;
  const mixinKey = MIXIN_KEY_ENC_TAB.map((index) => original[index] ?? "").join("").slice(0, 32);
  const entries = Object.entries({ ...params, wts: Math.floor(Date.now() / 1000) })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, String(value).replace(/[!'()*]/gu, "")] as const);
  const query = new URLSearchParams(entries.map(([key, value]) => [key, value])).toString();
  const wRid = createHash("md5").update(`${query}${mixinKey}`).digest("hex");
  return `${query}&w_rid=${wRid}`;
}

export { requestJson as requestBilibiliJson };

async function requestJson(
  url: string,
  cookie: string,
  requestPolicy?: OpenApiPlatformRequestPolicy,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const payload = await requestPayload(url, cookie, requestPolicy, signal);
  assertSuccessfulPayload(payload);
  return payload;
}

async function requestPayload(
  url: string,
  cookie: string,
  requestPolicy?: OpenApiPlatformRequestPolicy,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  await requestPolicy?.beforeRequest("bilibili", signal);
  const response = await fetchWithRetry(url, {
    cache: "no-store",
    headers: requestHeaders(cookie),
    signal,
    retry: {
      onResponse: (value) => requestPolicy?.observeResponse("bilibili", value),
      retryHttpStatuses: [429],
      retryOnDefaultHttpStatuses: !requestPolicy,
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  requestPolicy?.observePayload("bilibili", payload);
  if (!response.ok || !payload) throw new BilibiliApiError(`Bilibili 接口请求失败：HTTP ${response.status}`);
  return payload;
}

function assertSuccessfulPayload(payload: Record<string, unknown>): void {
  if (payload.code !== 0) {
    throw new BilibiliApiError(readString(payload.message) ?? "Bilibili 接口返回错误。", `BILIBILI_${payload.code}`);
  }
}

function requestHeaders(cookie: string): Record<string, string> {
  return {
    accept: "application/json,text/plain,*/*",
    referer: REFERER,
    "user-agent": USER_AGENT,
    ...(cookie.trim() ? { cookie: cookie.trim() } : {}),
  };
}

function chooseVideo(
  streams: BilibiliMediaStream[],
  codec: BilibiliVideoCodec,
  quality: BilibiliVideoQuality,
  strict: boolean,
): BilibiliMediaStream | undefined {
  const codecId = { avc: 7, hevc: 12, av1: 13 }[codec];
  const preferred = streams.filter((stream) => stream.codecId === codecId);
  if (strict && !preferred.length) return undefined;
  const candidates = preferred.length ? preferred : streams;
  const targetHeight = videoQualityTargetHeight(quality);
  if (strict && targetHeight) {
    return candidates.filter((stream) => stream.height === targetHeight).sort(byHighestVideo)[0];
  }
  return [...candidates].sort(videoQualityComparator(quality))[0];
}

function chooseAudio(
  streams: BilibiliMediaStream[],
  quality: BilibiliAudioQuality,
): BilibiliMediaStream | undefined {
  const targetId = audioQualityToId(quality);
  if (targetId) return streams.find((stream) => stream.id === targetId);
  return [...streams].sort(quality === "highest" ? byHighestBandwidth : byLowestBandwidth)[0];
}

function readStreams(value: unknown): BilibiliMediaStream[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): BilibiliMediaStream[] => {
    const stream = asRecord(item);
    const primary = readString(stream?.baseUrl ?? stream?.base_url);
    const backupValue = stream?.backupUrl ?? stream?.backup_url;
    const backups = Array.isArray(backupValue)
      ? backupValue.filter((url): url is string => typeof url === "string")
      : [];
    const id = readPositiveInteger(stream?.id);
    if (!primary || !id) return [];
    return [{
      bandwidth: readPositiveNumber(stream?.bandwidth) ?? id,
      codecId: readPositiveInteger(stream?.codecid),
      height: readPositiveInteger(stream?.height),
      id,
      urls: [primary, ...backups],
    }];
  });
}

function qualityToQn(quality: BilibiliVideoQuality): number {
  return {
    lowest: 16,
    "360p": 16,
    "480p": 32,
    "540p": 64,
    "720p": 64,
    "1080p": 80,
    "1440p": 112,
    "2160p": 120,
    "4320p": 127,
    highest: 127,
  }[quality];
}

function audioQualityToId(quality: BilibiliAudioQuality): number | undefined {
  return {
    "64k": 30216,
    "132k": 30232,
    "192k": 30280,
    dolby: 30250,
    hiRes: 30251,
    highest: undefined,
    lowest: undefined,
  }[quality];
}

function videoQualityTargetHeight(quality: BilibiliVideoQuality): number | undefined {
  return {
    "360p": 360,
    "480p": 480,
    "540p": 540,
    "720p": 720,
    "1080p": 1080,
    "1440p": 1440,
    "2160p": 2160,
    "4320p": 4320,
    highest: undefined,
    lowest: undefined,
  }[quality];
}

function videoQualityComparator(quality: BilibiliVideoQuality): (left: BilibiliMediaStream, right: BilibiliMediaStream) => number {
  const targetHeight = videoQualityTargetHeight(quality);
  if (!targetHeight) return quality === "highest" ? byHighestVideo : byLowestVideo;
  return (left, right) => {
    const leftDistance = Math.abs((left.height ?? 0) - targetHeight);
    const rightDistance = Math.abs((right.height ?? 0) - targetHeight);
    return leftDistance - rightDistance || byHighestVideo(left, right);
  };
}

function byLowestBandwidth(left: BilibiliMediaStream, right: BilibiliMediaStream): number {
  return left.bandwidth - right.bandwidth || left.id - right.id;
}

function byHighestBandwidth(left: BilibiliMediaStream, right: BilibiliMediaStream): number {
  return right.bandwidth - left.bandwidth || right.id - left.id;
}

function byLowestVideo(left: BilibiliMediaStream, right: BilibiliMediaStream): number {
  return (left.height ?? Infinity) - (right.height ?? Infinity) || byLowestBandwidth(left, right);
}

function byHighestVideo(left: BilibiliMediaStream, right: BilibiliMediaStream): number {
  return (right.height ?? 0) - (left.height ?? 0) || right.bandwidth - left.bandwidth;
}

function fileStem(value: string | undefined): string | undefined {
  return value?.match(/\/([^/?]+)\.[^./?]+(?:\?|$)/u)?.[1];
}

function normalizeImageUrl(value: string | undefined): string | undefined {
  return value?.startsWith("//") ? `https:${value}` : value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
