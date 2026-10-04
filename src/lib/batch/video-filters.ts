import { z } from "zod";
import type { AuthorVideo } from "./contracts";

export const AuthorVideoFiltersSchema = z.object({
  publishedFrom: z.iso.date().optional(),
  publishedTo: z.iso.date().optional(),
  order: z.enum(["newest", "oldest"]).default("newest"),
  limit: z.number({ error: "作品数量必须为整数。" }).int("作品数量必须为整数。").min(1, "作品数量至少为 1。").max(5000, "作品数量最多为 5000。").optional(),
  keyword: z.string().trim().max(200).default("").transform(normalizeSearchText),
  tags: z.array(z.string().trim().min(1).max(200)).max(20).default([]).transform((tags) => normalizeTags(tags).sort()),
  tagMode: z.enum(["any", "all"]).default("any"),
}).refine(
  ({ publishedFrom, publishedTo }) => !publishedFrom || !publishedTo || publishedFrom <= publishedTo,
  { message: "开始日期不能晚于结束日期。", path: ["publishedTo"] },
);
export type AuthorVideoFilters = z.infer<typeof AuthorVideoFiltersSchema>;

export type VideoFilterDraft = {
  mode: "all" | "newest" | "oldest";
  limit: string;
  publishedFrom: string;
  publishedTo: string;
  keyword: string;
  tags: string;
  tagMode: "any" | "all";
};
export const DEFAULT_FILTER_DRAFT: VideoFilterDraft = {
  mode: "all", limit: "50", publishedFrom: "", publishedTo: "", keyword: "", tags: "", tagMode: "any",
};

export function parseFilterDraft(draft: VideoFilterDraft) {
  return AuthorVideoFiltersSchema.safeParse({
    order: draft.mode === "oldest" ? "oldest" : "newest",
    limit: draft.mode === "all" ? undefined : /^\d+$/u.test(draft.limit.trim()) ? Number(draft.limit) : NaN,
    publishedFrom: draft.publishedFrom || undefined,
    publishedTo: draft.publishedTo || undefined,
    keyword: draft.keyword,
    tags: draft.tags.normalize("NFKC").split(/[,\n#]+/u).map((tag) => tag.trim()).filter(Boolean),
    tagMode: draft.tagMode,
  });
}

export function draftFromFilters(filters: AuthorVideoFilters): VideoFilterDraft {
  return {
    mode: filters.limit ? filters.order : "all",
    limit: String(filters.limit ?? 50),
    publishedFrom: filters.publishedFrom ?? "", publishedTo: filters.publishedTo ?? "",
    keyword: filters.keyword, tags: filters.tags.join(", "), tagMode: filters.tagMode,
  };
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function normalizeTags(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeSearchText(value).replace(/^#+/u, "").trim()).filter(Boolean))];
}

export function extractHashtags(title: string): string[] {
  return [...title.normalize("NFKC").matchAll(/#([^\s#,]+)/gu)].map((match) => match[1]);
}

export function createAuthorVideoMatcher(filters: AuthorVideoFilters) {
  // User-facing dates are inclusive calendar days in Asia/Shanghai, independent of browser/server timezone.
  const from = filters.publishedFrom ? Date.parse(`${filters.publishedFrom}T00:00:00+08:00`) : null;
  const until = filters.publishedTo ? Date.parse(`${filters.publishedTo}T00:00:00+08:00`) + 86_400_000 : null;
  const keyword = normalizeSearchText(filters.keyword);
  const tags = normalizeTags(filters.tags);
  return (video: AuthorVideo): boolean => {
    if ((from !== null || until !== null) && !video.publishedAt) return false;
    if (from !== null && video.publishedAt < from) return false;
    if (until !== null && video.publishedAt >= until) return false;
    if (keyword && !normalizeSearchText(video.title).includes(keyword)) return false;
    if (!tags.length) return true;
    const actual = new Set(normalizeTags([...(video.tags ?? []), ...extractHashtags(video.title)]));
    return filters.tagMode === "all" ? tags.every((tag) => actual.has(tag)) : tags.some((tag) => actual.has(tag));
  };
}

export function selectAuthorVideos(videos: readonly AuthorVideo[], filters: AuthorVideoFilters): AuthorVideo[] {
  const matches = createAuthorVideoMatcher(filters);
  const unique = new Map<string, AuthorVideo>();
  for (const video of videos) {
    if (matches(video)) unique.set(video.id, video);
  }
  const result = [...unique.values()].sort((left, right) => {
    const byTime = !left.publishedAt || !right.publishedAt
      ? Number(!left.publishedAt) - Number(!right.publishedAt)
      : filters.order === "oldest" ? left.publishedAt - right.publishedAt : right.publishedAt - left.publishedAt;
    return byTime || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });
  return filters.limit ? result.slice(0, filters.limit) : result;
}
