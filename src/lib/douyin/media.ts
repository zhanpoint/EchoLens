export type MediaResources = {
  imageUrls: string[];
  videoUrls?: string[];
};

export type CollectedContent = MediaResources & {
  caption?: string;
  articleText?: string;
};

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
