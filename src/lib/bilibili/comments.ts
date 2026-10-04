import type {
  Comment,
  CommentAuthor,
  CommentCollectionProgress,
  CommentsPayload,
} from "@/lib/comment-model";
import { BilibiliApiError, requestBilibiliWbiJson } from "./client";

const MAIN_COMMENTS_URL = "https://api.bilibili.com/x/v2/reply/wbi/main";

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
    for (const item of page.items) {
      const comment = normalizeComment(item);
      if (!comment.id || seenIds.has(comment.id)) continue;
      seenIds.add(comment.id);
      comments.push(comment);
    }
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

function normalizeComment(item: Record<string, unknown>): Comment {
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
