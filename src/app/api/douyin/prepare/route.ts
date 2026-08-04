import { NextResponse } from "next/server";
import { z } from "zod";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import {
  assetUrl,
  prepareAssetBundle,
  type PreparedAsset,
  type PreparedAssetKind,
} from "@/lib/douyin/asset-bundle";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";
import { readDownloadVideoQuality } from "@/lib/download-settings";
import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";
import { readUserSetting } from "@/lib/user-settings";
import { readReusableHistoryAsset, savePreparedHistoryAsset } from "@/lib/transcript/assets";
import { updateTranscriptHistoryRecordMetadata } from "@/lib/transcript/db";
import { DOUYIN_KINDS } from "@/types/douyin";

export const runtime = "nodejs";
export const maxDuration = 600;

const InputSchema = z.object({
  finalUrl: z.url().max(2_000),
  historyRecordId: z.string().min(1).max(128),
  id: z.string().regex(/^\d{6,30}$/),
  kind: z.enum(DOUYIN_KINDS),
});

type PrepareEvent =
  | { metadata: Record<string, unknown>; type: "metadata" }
  | { asset: ReturnType<typeof serializeAsset>; type: "asset" }
  | { asset: PreparedAssetKind; code?: string; error: string; type: "asset-error" }
  | { type: "done" }
  | { code?: string; error: string; type: "error" };

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const parsed = InputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "作品参数无效。" }, { status: 400 });
  }
  const videoQuality = readDownloadVideoQuality(await readUserSetting(user.id, "download"));

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: PrepareEvent) => {
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
          // The browser may close the stream while server-side caching continues.
        }
      };
      request.signal.addEventListener("abort", close, { once: true });

      void acquireWorkMetadata(parsed.data, videoQuality).then(async (lease) => {
        try {
          const { metadata } = lease;
          const history = await updateTranscriptHistoryRecordMetadata({
            authorName: metadata.authorName,
            authorUrl: metadata.authorUrl,
            caption: metadata.caption,
            durationSeconds: metadata.durationSeconds,
            historyRecordId: parsed.data.historyRecordId,
            userId: user.id,
          });
          if (!history) throw new Error("会话不存在或无权访问。");
          send({
            metadata: {
              authorName: metadata.authorName,
              authorUrl: metadata.authorUrl,
              caption: metadata.caption,
              durationSeconds: metadata.durationSeconds,
            },
            type: "metadata",
          });

          const reusableOriginalAudio = await readReusableHistoryAsset({
            assetKind: "originalAudio",
            historyRecordId: parsed.data.historyRecordId,
            userId: user.id,
          });
          const preparation = prepareAssetBundle(
            { ...parsed.data, videoQuality },
            metadata,
            reusableOriginalAudio?.durationSeconds
              ? {
                  originalAudio: {
                    contentType: reusableOriginalAudio.contentType,
                    durationSeconds: reusableOriginalAudio.durationSeconds,
                    objectKey: reusableOriginalAudio.objectKey,
                    sizeBytes: reusableOriginalAudio.sizeBytes,
                  },
                }
              : undefined,
          );
          await Promise.all(Object.entries(preparation.assets).map(async ([asset, task]) => {
            try {
              const prepared = await task;
              const saved = await savePreparedHistoryAsset({
                historyRecordId: parsed.data.historyRecordId,
                prepared,
                userId: user.id,
              });
              if (!saved) throw new Error("会话不存在或无权访问。");
              send({ asset: serializeAsset(prepared), type: "asset" });
            } catch (error) {
              logServerError(`douyin.prepare.${asset}`, error);
              const networkFailure = error instanceof NetworkRetryExhaustedError;
              send({
                asset: asset as PreparedAssetKind,
                ...(networkFailure ? { code: NETWORK_RETRY_ERROR_CODE } : {}),
                error: networkFailure
                  ? NETWORK_RETRY_ERROR_MESSAGE
                  : `${assetLabel(asset as PreparedAssetKind)}缓存失败。`,
                type: "asset-error",
              });
            }
          }));
          await preparation.completed;
        } finally {
          lease.release();
        }
        send({ type: "done" });
      }).catch((error: unknown) => {
        logServerError("douyin.prepare.metadata", error);
        const networkFailure = error instanceof NetworkRetryExhaustedError;
        send({
          ...(networkFailure ? { code: NETWORK_RETRY_ERROR_CODE } : {}),
          error: networkFailure ? NETWORK_RETRY_ERROR_MESSAGE : "作品信息加载失败，请稍后重试。",
          type: "error",
        });
      }).finally(close);
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

function serializeAsset(prepared: PreparedAsset) {
  const base = {
    asset: prepared.asset,
    contentType: prepared.value.contentType,
    objectKey: prepared.value.objectKey,
    sizeBytes: prepared.value.sizeBytes,
    url: assetUrl(prepared.value),
  };
  return prepared.asset === "originalAudio"
    ? {
        ...base,
        durationSeconds: prepared.value.durationSeconds,
        verified: true,
      }
    : base;
}

function assetLabel(asset: PreparedAssetKind): string {
  if (asset === "avatar") return "作者头像";
  if (asset === "cover") return "作品封面";
  if (asset === "video") return "作品视频";
  return "原声";
}