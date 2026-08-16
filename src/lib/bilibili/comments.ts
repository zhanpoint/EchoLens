import type {
  Comment,
  CommentAuthor,
  CommentCollectionProgress,
  CommentReply,
  CommentsPayload,
} from "@/lib/comment-model";
import { BilibiliApiError, requestBilibiliWbiJson } from "./client";

const MAIN_COMMENTS_URL = "https://api.bilibili.com/x/v2/reply/wbi/main";
const REPLIES_URL = "https://api.bilibili.com/x/v2/reply/reply";
const PAGE_SIZE = 20;
const REPLY_CONCURRENCY = 4;

export type BilibiliCommentsPayload = CommentsPayload & {
  aid: number;
};

type CommentPage = {
  items: Record<string, unknown>[];
  nextOffset: string;
};

export async function collectBilibiliComments(input: {
  aid: number;
  cookie: string;
  onProgress?: (progress: CommentCollectionProgress) => void;
}): Promise<BilibiliCommentsPayload> {
  if (!Number.isSafeInteger(input.aid) || input.aid <= 0) {
    throw new BilibiliApiError("Bilibili 稿件 aid 无效。", "INVALID_AID");
  }
  if (!input.cookie.trim()) {
    throw new BilibiliApiError("Bilibili 评论采集需要有效登录 Cookie。", "LOGIN_REQUIRED");
  }

  const comments: Comment[] = [];
  const seenIds = new Set<string>();
  let offset = "";
  let pageNumber = 0;

  while (true) {
    const page = await requestMainCommentPage(input.aid, input.cookie, offset);
    const uniqueItems = page.items.filter((item) => {
      const id = readIdentifier(item.rpid_str, item.rpid);
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });
    const normalized = await mapConcurrent(uniqueItems, REPLY_CONCURRENCY, (item) => (
      normalizeCommentWithReplies(input.aid, input.cookie, item)
    ));
    comments.push(...normalized);
    pageNumber += 1;
    input.onProgress?.({ commentCount: comments.length, page: pageNumber });

    if (!page.nextOffset || page.nextOffset === offset) break;
    offset = page.nextOffset;
  }

  return {
    aid: input.aid,
    collectedAt: Date.now(),
    commentCount: comments.length,
    comments,
  };
}

async function requestMainCommentPage(aid: number, cookie: string, offset: string): Promise<CommentPage> {
  const payload = await requestBilibiliWbiJson(MAIN_COMMENTS_URL, {
    mode: 3,
    oid: aid,
    pagination_str: JSON.stringify({ offset }),
    plat: 1,
    seek_rpid: "",
    type: 1,
    web_location: 1315875,
  }, cookie);
  const data = readRecord(payload.data);
  const cursor = readRecord(data.cursor);
  return {
    items: readRecords(data.replies),
    nextOffset: cursor.is_end === true ? "" : readString(readRecord(cursor.pagination_reply).next_offset),
  };
}

async function normalizeCommentWithReplies(
  aid: number,
  cookie: string,
  item: Record<string, unknown>,
): Promise<Comment> {
  const comment = normalizeComment(item);
  if (comment.replyCount <= 0) return comment;

  const url = new URL(REPLIES_URL);
  for (const [key, value] of Object.entries({ oid: aid, pn: 1, ps: PAGE_SIZE, root: comment.id, type: 1 })) {
    url.searchParams.set(key, String(value));
  }
  const payload = await requestBilibiliWbiJson(url.origin + url.pathname, Object.fromEntries(url.searchParams), cookie);
  const data = readRecord(payload.data);
  const replies = readRecords(data.replies).map(normalizeReply).filter((reply) => reply.id);
  return {
    ...comment,
    replies,
    replyPageHasMore: comment.replyCount > replies.length,
  };
}

function normalizeComment(item: Record<string, unknown>): Comment {
  return {
    ...normalizeReply(item),
    replies: [],
    replyCount: readInteger(item.count, item.rcount),
    replyPageHasMore: false,
  };
}

function normalizeReply(item: Record<string, unknown>): CommentReply {
  return {
    author: normalizeAuthor(readRecord(item.member)),
    id: readIdentifier(item.rpid_str, item.rpid),
    likeCount: readInteger(item.like),
    publishedAt: readTimestamp(item.ctime),
    text: readString(readRecord(item.content).message),
  };
}

function normalizeAuthor(member: Record<string, unknown>): CommentAuthor {
  return {
    id: readIdentifier(member.mid),
    name: readString(member.uname) || "Bilibili 用户",
  };
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(readRecord).filter((item) => Object.keys(item).length > 0)
    : [];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function readTimestamp(value: unknown): number {
  const timestamp = readInteger(value);
  return timestamp > 0 && timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
}