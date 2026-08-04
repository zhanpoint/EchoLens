import { NextResponse } from "next/server";
import { z } from "zod";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import { readUsableBilibiliCookie } from "@/lib/bilibili/account";
import { bilibiliAssetUrl, ensureBilibiliAsset } from "@/lib/bilibili/assets";
import { resolveBilibiliWork } from "@/lib/bilibili/client";
import {
  readBilibiliAudioQuality,
  readBilibiliStreamFormat,
} from "@/lib/download-settings";
import type { PreparedAsset, PreparedAssetKind } from "@/lib/douyin/asset-bundle";
import { readReusableHistoryAsset, savePreparedHistoryAsset } from "@/lib/transcript/assets";
import { updateTranscriptHistoryRecordMetadata } from "@/lib/transcript/db";
import { readUserSetting } from "@/lib/user-settings";

export const runtime = "nodejs";
export const maxDuration = 600;

const InputSchema = z.object({
  finalUrl: z.url().max(2_000),
  historyRecordId: z.string().min(1).max(128),
  id: z.string().regex(/^BV[\p{L}\p{N}]+:\d+$/iu),
  kind: z.literal("video"),
});
const AUTO_ASSETS = ["avatar", "cover", "originalAudio"] as const satisfies readonly PreparedAssetKind[];

type PrepareEvent =
  | { metadata: Record<string, unknown>; type: "metadata" }
  | { asset: ReturnType<typeof serializeAsset>; type: "asset" }
  | { asset: PreparedAssetKind; error: string; type: "asset-error" }
  | { type: "done" }
  | { error: string; type: "error" };

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;
  const userId = user.id;
  const parsed = InputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bilibili 作品参数无效。" }, { status: 400 });
  const input = parsed.data;

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: PrepareEvent) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* client disconnected */ }
      };
      request.signal.addEventListener("abort", close, { once: true });
      void prepare().catch((error) => {
        logServerError("bilibili.prepare", error);
        send({ error: "Bilibili 作品资源准备失败，请稍后重试。", type: "error" });
      }).finally(close);

      async function prepare() {
        const [bilibiliSettings, downloadSettings] = await Promise.all([
          readUserSetting(userId, "bilibili"),
          readUserSetting(userId, "download"),
        ]);
        const cookie = readUsableBilibiliCookie(bilibiliSettings);
        const { metadata, work } = await resolveBilibiliWork(input.finalUrl, cookie);
        if (work.id !== input.id) throw new Error("Bilibili 作品标识与链接不一致。");
        const history = await updateTranscriptHistoryRecordMetadata({
          authorName: metadata.authorName,
          authorUrl: metadata.authorUrl,
          caption: metadata.caption,
          durationSeconds: metadata.durationSeconds,
          historyRecordId: input.historyRecordId,
          userId,
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

        const reusableAudio = await readReusableHistoryAsset({
          assetKind: "originalAudio",
          historyRecordId: input.historyRecordId,
          userId,
        });
        await Promise.all(AUTO_ASSETS.map(async (assetKind) => {
          try {
            const prepared = assetKind === "originalAudio" && reusableAudio
              ? {
                  asset: "originalAudio" as const,
                  value: {
                    contentType: reusableAudio.contentType,
                    durationSeconds: reusableAudio.durationSeconds ?? metadata.durationSeconds,
                    objectKey: reusableAudio.objectKey,
                    sizeBytes: reusableAudio.sizeBytes,
                  },
                }
              : await ensureBilibiliAsset({
                  assetKind,
                  cookie,
                  metadata,
                  audioQuality: readBilibiliAudioQuality(downloadSettings),
                  streamFormat: readBilibiliStreamFormat(downloadSettings),
                });
            const saved = await savePreparedHistoryAsset({
              historyRecordId: input.historyRecordId,
              prepared,
              userId,
            });
            if (!saved) throw new Error("会话不存在或无权访问。");
            send({ asset: serializeAsset(prepared), type: "asset" });
          } catch (error) {
            logServerError(`bilibili.prepare.${assetKind}`, error);
            send({ asset: assetKind, error: `${assetLabel(assetKind)}缓存失败。`, type: "asset-error" });
          }
        }));
        send({ type: "done" });
      }
    },
    cancel() { closed = true; },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function serializeAsset(prepared: PreparedAsset) {
  return {
    asset: prepared.asset,
    contentType: prepared.value.contentType,
    ...(prepared.asset === "originalAudio"
      ? { durationSeconds: prepared.value.durationSeconds, verified: true }
      : {}),
    objectKey: prepared.value.objectKey,
    sizeBytes: prepared.value.sizeBytes,
    url: bilibiliAssetUrl(prepared.value),
  };
}

function assetLabel(asset: PreparedAssetKind): string {
  if (asset === "avatar") return "作者头像";
  if (asset === "cover") return "作品封面";
  return "原声";
}
