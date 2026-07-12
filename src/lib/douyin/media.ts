export function cleanText(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return cleaned || undefined;
}

export function uniqueMediaReferences(urls: string[]): string[] {
  return Array.from(
    new Set(
      urls
        .map((url) => url.trim())
        .filter(Boolean)
        .filter(
          (url) =>
            url.startsWith("http://") ||
            url.startsWith("https://") ||
            url.startsWith("data:"),
        ),
    ),
  );
}

export function readDouyinAvatarUrl(user: Record<string, unknown>): string {
  for (const key of ["avatar_thumb", "avatar_medium", "avatar_larger"] as const) {
    const source = readRecord(user[key]);
    const urls = Array.isArray(source.url_list) ? source.url_list : [];
    const url = urls.find(
      (value): value is string =>
        typeof value === "string" && /^https?:\/\//i.test(value.trim()),
    );
    if (url) {
      return url.trim();
    }
  }
  return "";
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
