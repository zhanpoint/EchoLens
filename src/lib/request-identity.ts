export const CLIENT_COOKIE = "el_client";
export const CLIENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export type ClientIdentity = {
  id: string;
  isNew: boolean;
};

export function normalizeClientId(value: string | undefined): string | null {
  return value && /^[a-z0-9_-]{20,80}$/iu.test(value) ? value : null;
}

export function createClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export function readClientIdentityFromHeaders(headers: Headers): string {
  const cookieId = normalizeClientId(readCookie(headers.get("cookie"), CLIENT_COOKIE));
  return cookieId ? `client|${cookieId}` : `anon|${readAnonymousIdentity(headers)}`;
}

export function readAnonymousIdentity(headers: Headers): string {
  return stableHash([
    "anon",
    readClientIp(headers),
    headers.get("user-agent") ?? "",
  ].join("|"));
}

export function readClientIp(headers: Headers): string {
  return (
    firstHeaderValue(headers.get("cf-connecting-ip")) ??
    firstHeaderValue(headers.get("x-real-ip")) ??
    firstHeaderValue(headers.get("x-forwarded-for")) ??
    readForwardedFor(headers.get("forwarded")) ??
    "unknown"
  );
}

export function firstHeaderValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

export function stableHash(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36);
}

function readCookie(cookieHeader: string | null, name: string): string | undefined {
  return cookieHeader
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function readForwardedFor(value: string | null): string | null {
  const first = firstHeaderValue(value);
  const forwardedFor = first?.match(/(?:^|;)\s*for=(?:"?)([^";,]+)(?:"?)/iu)?.[1];
  return forwardedFor?.trim() || null;
}
