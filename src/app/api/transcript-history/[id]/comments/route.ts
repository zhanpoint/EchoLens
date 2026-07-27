import { NextResponse } from "next/server";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import { rejectDisabledDouyinAccountServices } from "@/app/api/douyin/_account-services";
import { readValidDouyinCredential } from "@/app/api/douyin/_credential";
import { markDouyinCredentialInvalid } from "@/lib/douyin/account";
import { collectDouyinComments } from "@/lib/douyin/comments";
import { createDouyinWebClient, DouyinApiError } from "@/lib/douyin/web-client";
import {
  readTranscriptHistoryComments,
  readTranscriptHistoryCommentsMetadata,
  upsertTranscriptHistoryComments,
} from "@/lib/transcript/comments";
import { readTranscriptHistoryRecord } from "@/lib/transcript/db";

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

  const disabled = rejectDisabledDouyinAccountServices(user);
  if (disabled) return disabled;

  const { id } = await context.params;
  const history = await readTranscriptHistoryRecord({ id, userId: user.id });
  if (!history) {
    return NextResponse.json({ error: "会话不存在。" }, { status: 404 });
  }

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

  const disabled = rejectDisabledDouyinAccountServices(user);
  if (disabled) return disabled;

  const { id } = await context.params;
  const history = await readTranscriptHistoryRecord({ id, userId: user.id });
  if (!history) {
    return NextResponse.json({ error: "会话不存在。" }, { status: 404 });
  }

  const credential = await readValidDouyinCredential(user.id);
  if (credential instanceof NextResponse) return credential;
  const client = createDouyinWebClient(credential);

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

      void collectDouyinComments({
        awemeId: history.workId,
        client,
        onProgress: (progress) => send({ ...progress, type: "progress" }),
      }).then(async (payload) => {
        const saved = await upsertTranscriptHistoryComments({
          historyRecordId: id,
          payload,
          userId: user.id,
        });
        if (!saved) throw new Error("会话不存在或无权访问。");
        send({ type: "done" });
      }).catch(async (error: unknown) => {
        logServerError("transcript-history.comments", error);
        const credentialRequired = error instanceof DouyinApiError &&
          (error.code === "LOGIN_REQUIRED" || error.code === "INVALID_COOKIE");
        if (credentialRequired) {
          await markDouyinCredentialInvalid(user.id);
        }
        send({
          code: credentialRequired ? "CREDENTIAL_INVALID" : "COMMENTS_UPSTREAM_ERROR",
          error: credentialRequired
            ? "抖音账号访问凭证已失效，请前往设置更新后重试。"
            : "评论采集失败，请稍后重试。",
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