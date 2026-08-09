import { NextResponse } from "next/server";
import { z } from "zod";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import { readUsableBilibiliCookie } from "@/lib/bilibili/account";
import {
  buildBilibiliWorkId,
  getBilibiliDashSelection,
  resolveBilibiliWork,
  type BilibiliMediaStream,
} from "@/lib/bilibili/client";
import {
  readBilibiliAudioQuality,
  readBilibiliVideoCodec,
  readBilibiliVideoQuality,
} from "@/lib/download-settings";
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

type PreparedBilibiliAssetKind = "avatar" | "cover" | "originalAudio" | "video";
type SerializedAsset = {
  asset: PreparedBilibiliAssetKind;
  contentType: string;
  durationSeconds?: number;
  objectKey: string;
  sizeBytes: number;
  url: string;
  verified?: boolean;
};
type PrepareEvent =
  | { metadata: Record<string, unknown>; type: "metadata" }
  | { asset: SerializedAsset; type: "asset" }
  | { asset: PreparedBilibiliAssetKind; error: string; type: "asset-error" }
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
        send({ error: "Bilibili DASH 资源准备失败，请稍后重试。", type: "error" });
      }).finally(close);

      async function prepare() {
        const [bilibiliSettings, downloadSettings] = await Promise.all([
          readUserSetting(userId, "bilibili"),
          readUserSetting(userId, "download"),
        ]);
        const cookie = readUsableBilibiliCookie(bilibiliSettings);
        const { metadata, work } = await resolveBilibiliWork(input.finalUrl, cookie);
        if (work.id !== input.id || buildBilibiliWorkId(metadata.bvid, metadata.cid) !== input.id) {
          throw new Error("Bilibili 作品标识与链接不一致。");
        }
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

        sendOptionalImage("avatar", metadata.authorAvatarUrls[0], `bilibili:${work.id}:avatar`);
        sendOptionalImage("cover", metadata.coverUrls[0], `bilibili:${work.id}:cover`);
        const selection = await getBilibiliDashSelection({
          audioQuality: readBilibiliAudioQuality(downloadSettings),
          bvid: metadata.bvid,
          cid: metadata.cid,
          codec: readBilibiliVideoCodec(downloadSettings),
          cookie,
          videoQuality: readBilibiliVideoQuality(downloadSettings),
        });
        sendDashAsset({
          asset: "video",
          contentType: "video/mp4",
          objectKey: `bilibili:${work.id}:video:${selection.video.id}:${selection.video.codecId ?? "unknown"}`,
          stream: selection.video,
        });
        sendDashAsset({
          asset: "originalAudio",
          contentType: contentTypeForAudio(selection.audio),
          durationSeconds: metadata.durationSeconds,
          objectKey: `bilibili:${work.id}:audio:${selection.audio.id}`,
          stream: selection.audio,
          verified: true,
        });
        send({ type: "done" });
      }

      function sendOptionalImage(asset: "avatar" | "cover", url: string | undefined, objectKey: string) {
        if (!url) {
          send({ asset, error: `${asset === "avatar" ? "作者头像" : "封面"}不可用。`, type: "asset-error" });
          return;
        }
        send({
          asset: { asset, contentType: "image/jpeg", objectKey, sizeBytes: 0, url },
          type: "asset",
        });
      }

      function sendDashAsset(input: Omit<SerializedAsset, "sizeBytes" | "url"> & { stream: BilibiliMediaStream }) {
        const url = input.stream.urls[0];
        if (!url) {
          send({ asset: input.asset, error: "Bilibili DASH 地址不可用。", type: "asset-error" });
          return;
        }
        const asset: SerializedAsset = {
          asset: input.asset,
          contentType: input.contentType,
          durationSeconds: input.durationSeconds,
          objectKey: input.objectKey,
          sizeBytes: 0,
          url,
          verified: input.verified,
        };
        send({ asset, type: "asset" });
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

function contentTypeForAudio(stream: BilibiliMediaStream): string {
  if (stream.id === 30251) return "audio/flac";
  if (stream.id === 30250) return "audio/eac3";
  return "audio/mp4";
}