const MIN_VALID_FUTURE_MS = 30_000;
const EXPLICIT_EXPIRY_REFRESH_WINDOW_MS = 5 * 60_000;
const EXPIRATION_KEYS = new Set([
  "deadline",
  "expire",
  "expires",
  "expires_at",
  "expiration",
  "wstime",
  "x-expires",
]);

export function inferSourceUrlsExpiresAt(
  urls: readonly (string | undefined)[],
  now = Date.now(),
): number | undefined {
  const expirations = urls.flatMap((value) => {
    if (!value) return [];
    try {
      const url = new URL(value);
      return [...url.searchParams.entries()].flatMap(([key, raw]) => {
        if (!EXPIRATION_KEYS.has(key.toLowerCase())) return [];
        const parsed = parseEpoch(raw);
        return parsed && parsed > now + MIN_VALID_FUTURE_MS ? [parsed] : [];
      });
    } catch {
      return [];
    }
  });
  return expirations.length ? Math.min(...expirations) : undefined;
}

export function sourceUrlsNeedRefresh(expiresAt: number | undefined, now = Date.now()): boolean {
  return expiresAt !== undefined && expiresAt <= now + EXPLICIT_EXPIRY_REFRESH_WINDOW_MS;
}

function parseEpoch(value: string): number | undefined {
  const numeric = /^[\da-f]{8}$/iu.test(value) ? Number.parseInt(value, 16) : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric >= 1_000_000_000_000 ? Math.floor(numeric) : Math.floor(numeric * 1_000);
}