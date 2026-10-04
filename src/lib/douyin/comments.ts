import type { DouyinWebClient } from "./web-client";
import type {
  Comment,
  CommentAuthor,
  CommentCollectionProgress,
  CommentsPayload,
} from "@/lib/comment-model";

const PAGE_SIZE = 20;

export type DouyinCommentsPayload = CommentsPayload & {
  awemeId: string;
};

type PagedComments = {
  hasMore: boolean;
  items: Record<string, unknown>[];
  nextCursor: number;
};

export async function collectDouyinComments({
  awemeId,
  client,
  onProgress,
}: {
  awemeId: string;
  client: DouyinWebClient;
  onProgress?: (progress: CommentCollectionProgress) => void;
}): Promise<DouyinCommentsPayload> {
  const comments: Comment[] = [];
  const seenIds = new Set<string>();
  let cursor = 0;
  let pageNumber = 0;
  let page = await requestCommentPage(client, awemeId, cursor);

  while (page.items.length > 0) {
    for (const item of page.items) {
      const comment = normalizeComment(item);
      if (!comment.id || seenIds.has(comment.id)) continue;
      seenIds.add(comment.id);
      comments.push(comment);
    }
    pageNumber += 1;
    onProgress?.({ commentCount: comments.length, page: pageNumber });

    if (!page.hasMore || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
    page = await requestCommentPage(client, awemeId, cursor);
  }

  return {
    awemeId,
    collectedAt: Date.now(),
    commentCount: comments.length,
    comments,
  };
}

async function requestCommentPage(
  client: DouyinWebClient,
  awemeId: string,
  cursor: number,
): Promise<PagedComments> {
  const payload = await client.request("/aweme/v1/web/comment/list/", {
    ...client.query(),
    aweme_id: awemeId,
    count: PAGE_SIZE,
    cursor,
    cut_version: "1",
    insert_ids: "",
    item_type: "0",
    rcFT: "",
    whale_cut_token: "",
  });
  return normalizePage(payload);
}

function normalizeComment(item: Record<string, unknown>): Comment {
  return {
    author: normalizeAuthor(readRecord(item.user)),
    id: readIdentifier(item.cid, item.comment_id),
    likeCount: readInteger(item.digg_count, item.like_count),
    publishedAt: readTimestamp(item.create_time, item.ctime),
    text: readString(item.text, item.content),
  };
}

function normalizeAuthor(user: Record<string, unknown>): CommentAuthor {
  return {
    id: readIdentifier(user.sec_uid, user.secUid, user.uid, user.id),
    name: readString(user.nickname, user.name) || "抖音用户",
  };
}

function normalizePage(payload: Record<string, unknown>): PagedComments {
  const root = readRecord(payload.data, payload);
  const items = Array.isArray(root.comments)
    ? root.comments.map(readRecord).filter((item) => Object.keys(item).length > 0)
    : [];
  return {
    hasMore: readBoolean(root.has_more),
    items,
    nextCursor: readInteger(root.cursor, root.max_cursor),
  };
}

function readRecord(value: unknown, fallback: unknown = {}): Record<string, unknown> {
  const selected = value ?? fallback;
  return selected && typeof selected === "object" && !Array.isArray(selected)
    ? selected as Record<string, unknown>
    : {};
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function readIdentifier(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  }
  return "";
}

function readInteger(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
  }
  return 0;
}

function readTimestamp(...values: unknown[]): number {
  const value = readInteger(...values);
  return value > 0 && value < 10_000_000_000 ? value * 1_000 : value;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}
