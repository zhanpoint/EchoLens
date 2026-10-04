import { describe, expect, it } from "vitest";
import { AuthorVideoFiltersSchema, DEFAULT_FILTER_DRAFT, createAuthorVideoMatcher, draftFromFilters, parseFilterDraft, selectAuthorVideos } from "@/lib/batch/video-filters";
import type { AuthorVideo } from "@/lib/batch/contracts";

const video = (id: string, date: string, tags: string[] = []): AuthorVideo => ({ id, title: `作品 ${id}`, publishedAt: date ? Date.parse(date) : 0, tags, durationSeconds: 10, coverUrl: "" });

describe("author video filters", () => {
  it("defaults to every video and ranks by timestamps rather than pinned upstream order", () => {
    const list = [video("pinned", "2020-01-01"), video("newest", "2026-10-03"), video("middle", "2025-01-01"), video("unknown", "")];
    expect(selectAuthorVideos(list, AuthorVideoFiltersSchema.parse({})).map(({ id }) => id)).toEqual(["newest", "middle", "pinned", "unknown"]);
    expect(selectAuthorVideos(list, AuthorVideoFiltersSchema.parse({ limit: 2 })).map(({ id }) => id)).toEqual(["newest", "middle"]);
    expect(selectAuthorVideos(list, AuthorVideoFiltersSchema.parse({ order: "oldest", limit: 2 })).map(({ id }) => id)).toEqual(["pinned", "middle"]);
  });

  it("includes both boundary dates in Beijing time and excludes missing publication times", () => {
    const matches = createAuthorVideoMatcher(AuthorVideoFiltersSchema.parse({ publishedFrom: "2026-10-03", publishedTo: "2026-10-03" }));
    expect(matches(video("start", "2026-10-02T16:00:00Z"))).toBe(true);
    expect(matches(video("end", "2026-10-03T15:59:59.999Z"))).toBe(true);
    expect(matches(video("before", "2026-10-02T15:59:59.999Z"))).toBe(false);
    expect(matches(video("after", "2026-10-03T16:00:00Z"))).toBe(false);
    expect(matches(video("unknown", ""))).toBe(false);
  });

  it("combines title and exact normalized tags before taking the count", () => {
    const list = [video("1", "2026-10-03", ["AI工具"]), video("2", "2026-10-02", ["ＡＩ", "摄影"]), video("3", "2026-10-01", ["ai"])];
    const any = AuthorVideoFiltersSchema.parse({ tags: ["#AI", "#摄影"], keyword: "作品", limit: 1 });
    expect(selectAuthorVideos(list, any).map(({ id }) => id)).toEqual(["2"]);
    expect(selectAuthorVideos(list, { ...any, limit: undefined, tagMode: "all" }).map(({ id }) => id)).toEqual(["2"]);
  });

  it("matches title hashtags in cached videos without losing explicit topic metadata", () => {
    const list = [
      { ...video("1", "2026-10-03"), title: "1分钟猜城市#网络谜踪 #侦探挑战赛" },
      { ...video("2", "2026-10-02", ["科普"]), title: "城市#网络谜踪" },
      { ...video("3", "2026-10-01"), title: "#网络谜踪挑战" },
    ];
    expect(selectAuthorVideos(list, AuthorVideoFiltersSchema.parse({ tags: ["#网络谜踪"] })).map(({ id }) => id)).toEqual(["1", "2"]);
    expect(selectAuthorVideos(list, AuthorVideoFiltersSchema.parse({ tags: ["网络谜踪", "科普"], tagMode: "all" })).map(({ id }) => id)).toEqual(["2"]);
  });

  it("merges repeated pages and retains the correct oldest count incrementally", () => {
    const filters = AuthorVideoFiltersSchema.parse({ order: "oldest", limit: 2 });
    const first = selectAuthorVideos([video("3", "2026-01-03"), video("4", "2026-01-04")], filters);
    const merged = selectAuthorVideos([...first, video("3", "2026-01-03"), video("1", "2026-01-01"), video("2", "2026-01-02")], filters);
    expect(merged.map(({ id }) => id)).toEqual(["1", "2"]);
  });

  it("rejects invalid dates, reversed ranges and invalid counts", () => {
    for (const filters of [{ publishedFrom: "2026-02-30" }, { publishedFrom: "2026-10-03", publishedTo: "2026-10-02" }, { limit: 0 }, { limit: 5001 }, { limit: 1.5 }])
      expect(AuthorVideoFiltersSchema.safeParse(filters).success).toBe(false);
  });

  it("canonicalizes full-width hashtags, comma separators, repeated tags and keyword casing", () => {
    const parsed = parseFilterDraft({ ...DEFAULT_FILTER_DRAFT, keyword: " ＡＩ Tutorial ", tags: " ＃ＡＩ，#摄影\n#ai " });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({ keyword: "ai tutorial", tags: ["ai", "摄影"] });
    expect(selectAuthorVideos([{ ...video("1", "2026-10-03"), title: "AI TUTORIAL ＃摄影，＃ＡＩ" }], parsed.data).map(({ id }) => id)).toEqual(["1"]);
    expect(parseFilterDraft(draftFromFilters(parsed.data))).toEqual(parsed);
    expect(AuthorVideoFiltersSchema.parse({ tags: ["# 摄影 ", "ＡＩ", "ai", "摄影"] }).tags).toEqual(parsed.data.tags);
  });

  it("validates decimal quantity drafts and ignores inactive count fields in all mode", () => {
    for (const limit of ["", " ", "1e2", "0x10", "1.5", "-1", "0", "5001"]) {
      expect(parseFilterDraft({ ...DEFAULT_FILTER_DRAFT, mode: "newest", limit }).success).toBe(false);
      expect(parseFilterDraft({ ...DEFAULT_FILTER_DRAFT, limit }).success).toBe(true);
    }
    for (const mode of ["newest", "oldest"] as const) {
      for (const limit of ["1", "5000", " 002 "]) {
        const parsed = parseFilterDraft({ ...DEFAULT_FILTER_DRAFT, mode, limit });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.limit).toBe(Number(limit));
          expect(parsed.data.order).toBe(mode);
          expect(parseFilterDraft(draftFromFilters(parsed.data))).toEqual(parsed);
        }
      }
    }
  });

  it("applies date, keyword and every-tag matching before latest or earliest truncation", () => {
    const list = [
      { ...video("old", "2026-10-02T15:59:59Z", ["摄影", "旅行"]), title: "城市教程" },
      { ...video("first", "2026-10-02T16:00:00Z", ["摄影", "旅行"]), title: "城市教程" },
      { ...video("one-tag", "2026-10-03T02:00:00Z", ["摄影"]), title: "城市教程" },
      { ...video("other-title", "2026-10-03T03:00:00Z", ["摄影", "旅行"]), title: "其他内容" },
      { ...video("last", "2026-10-03T15:59:59.999Z", ["摄影", "旅行"]), title: "城市教程" },
      { ...video("next-day", "2026-10-03T16:00:00Z", ["摄影", "旅行"]), title: "城市教程" },
    ];
    const filters = AuthorVideoFiltersSchema.parse({ publishedFrom: "2026-10-03", publishedTo: "2026-10-03", keyword: "城市", tags: ["摄影", "旅行"], tagMode: "all", limit: 1 });
    expect(selectAuthorVideos(list, filters).map(({ id }) => id)).toEqual(["last"]);
    expect(selectAuthorVideos(list, { ...filters, order: "oldest" }).map(({ id }) => id)).toEqual(["first"]);
    expect(selectAuthorVideos(list, { ...filters, limit: undefined, tagMode: "any" }).map(({ id }) => id)).toEqual(["last", "one-tag", "first"]);
    expect(selectAuthorVideos(list, AuthorVideoFiltersSchema.parse({ publishedFrom: "2026-10-04" })).map(({ id }) => id)).toEqual(["next-day"]);
    expect(selectAuthorVideos(list, AuthorVideoFiltersSchema.parse({ publishedTo: "2026-10-02" })).map(({ id }) => id)).toEqual(["old"]);
  });

  it("keeps identical rankings across page boundaries, overlaps and pinned ordering", () => {
    const list = Array.from({ length: 90 }, (_, i) => ({
      ...video(String(i).padStart(3, "0"), i % 11 === 0 ? "" : `2026-10-${String(i % 4 + 1).padStart(2, "0")}T08:00:00+08:00`, i % 3 ? ["摄影", "旅行"] : ["摄影"]),
      title: i % 5 ? "城市教程" : "其他内容",
    }));
    for (const order of ["newest", "oldest"] as const) {
      for (const tagMode of ["any", "all"] as const) {
        for (const limit of [undefined, 1, 7, 5000]) {
          const filters = AuthorVideoFiltersSchema.parse({ order, tagMode, limit, keyword: "教程", tags: ["摄影", "旅行"], publishedFrom: "2026-10-02", publishedTo: "2026-10-03" });
          const expected = selectAuthorVideos(list, filters).map(({ id }) => id);
          for (const ordered of [list, [...list].reverse(), [...list.slice(45), ...list.slice(0, 45)]]) {
            let candidates: AuthorVideo[] = [];
            for (let offset = 0; offset < ordered.length; offset += 13) {
              candidates = selectAuthorVideos([...candidates, ...ordered.slice(Math.max(0, offset - 2), offset + 13)], filters);
            }
            expect(candidates.map(({ id }) => id)).toEqual(expected);
          }
        }
      }
    }
  });
});
