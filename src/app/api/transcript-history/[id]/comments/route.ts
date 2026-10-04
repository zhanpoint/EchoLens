import { NextResponse } from "next/server";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import { rejectDisabledDouyinAccountServices } from "@/app/api/douyin/_account-services";
import { readValidDouyinCredential } from "@/app/api/douyin/_credential";
import { readUsableBilibiliCookie } from "@/lib/bilibili/account";
import { resolveBilibiliWork, BilibiliApiError } from "@/lib/bilibili/client";
import { collectBilibiliComments } from "@/lib/bilibili/comments";
import { markDouyinCredentialInvalid } from "@/lib/douyin/account";
import { collectDouyinComments } from "@/lib/douyin/comments";
import { createDouyinWebClient, DouyinApiError } from "@/lib/douyin/web-client";
import { mediaSourceFromWorkKey } from "@/lib/media/source";
import {
  readTranscriptHistoryComments,
  readTranscriptHistoryCommentsMetadata,
  upsertTranscriptHistoryComments,
} from "@/lib/transcript/comments";
import { readTranscriptHistoryRecord, type TranscriptHistoryRecord } from "@/lib/transcript/db";
import { readUserSetting } from "@/lib/user-settings";

export const runtime = "nodejs";
export const maxDuration = 600;

const runningCollections = new Set<string>();

type RouteContext = {
  params: Promise<{ id: string }>;
};

type CollectionEvent =
  | { commentCount: number; page: number; type: "progress" }
  | { type: "done" }
  | { code: string; error: string; type: "error" };

export async function GET(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const { id } = await context.params;
  const history = await readTranscriptHistoryRecord({ id, userId: user.id });
  if (!history) {
    return NextResponse.json({ error: "会话不存在。" }, { status: 404 });
  }
  const source = mediaSourceFromWorkKey(history.workKey);
  const disabled = source === "douyin" ? rejectDisabledDouyinAccountServices(user) : null;
  if (disabled) return disabled;

  const url = new URL(request.url);
  if (url.searchParams.get("metadata") === "1") {
    const metadata = await readTranscriptHistoryCommentsMetadata({
      historyRecordId: id,
      userId: user.id,
    });
    return NextResponse.json({ metadata }, { headers: { "cache-control": "private, no-store" } });
  }

  const payload = await readTranscriptHistoryComments({ historyRecordId: id, userId: user.id });
  if (!payload) {
    return NextResponse.json({ error: "尚未采集评论。" }, { status: 404 });
  }
  if (url.searchParams.get("download") === "1") {
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="echolens-${history.workId}-comments.json"`,
        "content-type": "application/json; charset=utf-8",
      },
    });
  }
  return NextResponse.json({ payload }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const { id } = await context.params;
  const history = await readTranscriptHistoryRecord({ id, userId: user.id });
  if (!history) {
    return NextResponse.json({ error: "会话不存在。" }, { status: 404 });
  }
  const source = mediaSourceFromWorkKey(history.workKey);
  const disabled = source === "douyin" ? rejectDisabledDouyinAccountServices(user) : null;
  if (disabled) return disabled;

  const collect = source === "bilibili"
    ? await createBilibiliCollection(history, user.id)
    : await createDouyinCollection(history, user.id);
  if (collect instanceof NextResponse) return collect;

  const collectionKey = `${user.id}:${id}`;
  if (runningCollections.has(collectionKey)) {
    return NextResponse.json({ code: "COMMENTS_BUSY", error: "评论正在采集中。" }, { status: 409 });
  }
  runningCollections.add(collectionKey);

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: CollectionEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The client may disconnect while the collection continues to persist.
        }
      };

      void collect((progress) => send({ ...progress, type: "progress" })).then(async (payload) => {
        const saved = await upsertTranscriptHistoryComments({
          historyRecordId: id,
          payload,
          userId: user.id,
        });
        if (!saved) throw new Error("会话不存在或无权访问。");
        send({ type: "done" });
      }).catch(async (error: unknown) => {
        logServerError("transcript-history.comments", error);
        const douyinCredentialRequired = source === "douyin" && error instanceof DouyinApiError &&
          (error.code === "LOGIN_REQUIRED" || error.code === "INVALID_COOKIE");
        const bilibiliCredentialRequired = source === "bilibili" && error instanceof BilibiliApiError &&
          (error.code === "BILIBILI_-101" || error.code === "LOGIN_REQUIRED");
        if (douyinCredentialRequired) {
          await markDouyinCredentialInvalid(user.id);
        }
        const credentialRequired = douyinCredentialRequired || bilibiliCredentialRequired;
        send({
          code: credentialRequired ? "CREDENTIAL_INVALID" : error instanceof DouyinApiError ? error.code : "COMMENTS_UPSTREAM_ERROR",
          error: credentialRequired
            ? `${source === "bilibili" ? "Bilibili" : "抖音"}账号访问凭证已失效，请前往设置更新后重试。`
            : error instanceof DouyinApiError ? error.message : "评论采集失败，请稍后重试。",
          type: "error",
        });
      }).finally(() => {
        runningCollections.delete(collectionKey);
        close();
      });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

type CollectComments = (
  onProgress: (progress: { commentCount: number; page: number }) => void,
) => Promise<import("@/lib/transcript/comments").StoredCommentsPayload>;

async function createDouyinCollection(
  history: TranscriptHistoryRecord,
  userId: string,
): Promise<CollectComments | NextResponse> {
  const credential = await readValidDouyinCredential(userId);
  if (credential instanceof NextResponse) return credential;
  const client = createDouyinWebClient(credential);
  return (onProgress) => collectDouyinComments({ awemeId: history.workId, client, onProgress });
}

async function createBilibiliCollection(
  history: TranscriptHistoryRecord,
  userId: string,
): Promise<CollectComments | NextResponse> {
  const cookie = readUsableBilibiliCookie(await readUserSetting(userId, "bilibili"));
  if (!cookie) {
    return NextResponse.json({
      code: "CREDENTIAL_MISSING",
      error: "尚未设置有效的 Bilibili 登录凭证，请先前往设置完成登录。",
    }, { status: 409 });
  }
  const { metadata } = await resolveBilibiliWork(history.finalUrl, cookie);
  return (onProgress) => collectBilibiliComments({ aid: metadata.aid, cookie, onProgress });
}
