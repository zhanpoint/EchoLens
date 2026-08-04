export const MEDIA_SOURCES = ["douyin", "bilibili"] as const;

export type MediaSource = (typeof MEDIA_SOURCES)[number];

const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s"'<>，。！？；、）】》\\]+/iu;
const TRAILING_URL_PUNCTUATION_PATTERN = /[)\]}.,!?;:，。！？；：、]+$/u;
const SOURCE_BY_HOST_TOKEN = [
  ["douyin", "douyin"],
  ["bilibili", "bilibili"],
] as const satisfies ReadonlyArray<readonly [string, MediaSource]>;

export type ExtractedHttpUrl = {
  index: number;
  value: string;
};

export function parseHttpUrl(value: string, base?: string | URL): URL | null {
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function extractHttpUrl(value: string): ExtractedHttpUrl | null {
  const match = HTTP_URL_PATTERN.exec(value);
  if (!match) return null;

  const candidate = match[0].replace(TRAILING_URL_PUNCTUATION_PATTERN, "");
  return parseHttpUrl(candidate)
    ? { index: match.index, value: candidate }
    : null;
}

export function mediaSourceFromUrl(value: string | URL): MediaSource | null {
  const url = typeof value === "string" ? parseHttpUrl(value) : value;
  if (!url) return null;

  return SOURCE_BY_HOST_TOKEN.find(([token]) => url.hostname.includes(token))?.[1] ?? null;
}

export function mediaSourceFromWorkKey(workKey?: string): MediaSource {
  return workKey?.startsWith("bilibili:") ? "bilibili" : "douyin";
}

export function buildWorkKey(input: { id: string; kind: string; source?: MediaSource }): string {
  return input.source === "bilibili"
    ? `bilibili:${input.kind}:${input.id}`
    : `${input.kind}:${input.id}`;
}
