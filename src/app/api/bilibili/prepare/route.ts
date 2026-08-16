import { NextResponse } from "next/server";
import { z } from "zod";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import { readUsableBilibiliCookie } from "@/lib/bilibili/account";
import {
  buildBilibiliWorkId,
  getBilibiliDashSelection,
  resolveBilibiliWork,
} from "@/lib/bilibili/client";
import {
  readBilibiliAudioQuality,
  readBilibiliVideoCodec,
  readBilibiliVideoQuality,
} from "@/lib/download-settings";
import {
  prepareBilibiliSnapshotAsset,
  type AvailableHistoryAsset,
  type HistoryAssetKind,
} from "@/lib/transcript/assets";
import { createJsonSseResponse } from "@/lib/http/sse-response";
import {
  createBilibiliResourceSnapshot,
  snapshotHistoryMetadata,
} from "@/lib/media/resource-snapshot";
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

const PREPARED_ASSETS = ["avatar", "cover", "video", "originalAudio"] as const satisfies readonly HistoryAssetKind[];

type SerializedAsset = {
  asset: HistoryAssetKind;
  contentType: string;
  durationSeconds?: number;
  objectKey?: string;
  sizeBytes: number;
  url: string;
  urlExpiresAt?: number;
  verified?: boolean;
};

type PrepareEvent =
  | { metadata: Record<string, unknown>; type: "metadata" }
  | { asset: SerializedAsset; type: "asset" }
  | { asset: HistoryAssetKind; error: string; type: "asset-error" }
  | { type: "done" }
  | { error: string; type: "error" };

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const parsed = InputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Bilibili 作品参数无效。" }, { status: 400 });
  }

  return createJsonSseResponse<PrepareEvent>(request.signal, async ({ send }) => {
    try {
      const [bilibiliSettings, downloadSettings] = await Promise.all([
        readUserSetting(user.id, "bilibili"),
        readUserSetting(user.id, "download"),
      ]);
      const cookie = readUsableBilibiliCookie(bilibiliSettings);
      const { metadata, work } = await resolveBilibiliWork(parsed.data.finalUrl, cookie);
      if (work.id !== parsed.data.id || buildBilibiliWorkId(metadata.bvid, metadata.cid) !== parsed.data.id) {
        throw new Error("Bilibili 作品标识与链接不一致。");
      }

      const selection = await getBilibiliDashSelection({
        audioQuality: readBilibiliAudioQuality(downloadSettings),
        bvid: metadata.bvid,
        cid: metadata.cid,
        codec: readBilibiliVideoCodec(downloadSettings),
        cookie,
        videoQuality: readBilibiliVideoQuality(downloadSettings),
      });
      const snapshot = createBilibiliResourceSnapshot(metadata, selection);
      const history = await updateTranscriptHistoryRecordMetadata(
        snapshotHistoryMetadata({
          historyRecordId: parsed.data.historyRecordId,
          snapshot,
          userId: user.id,
        }),
      );
      if (!history) throw new Error("会话不存在或无权访问。");

      send({
        metadata: {
          authorName: snapshot.authorName,
          authorUrl: snapshot.authorUrl,
          caption: snapshot.caption,
          durationSeconds: snapshot.durationSeconds,
        },
        type: "metadata",
      });

      await Promise.all(PREPARED_ASSETS.map(async (assetKind) => {
        try {
          const asset = await prepareBilibiliSnapshotAsset({
            assetKind,
            historyRecordId: history.id,
            metadata,
            selection,
            snapshot,
            userId: user.id,
            workId: work.id,
            workKey: history.workKey,
          });
          if (!asset) throw new Error(`${assetLabel(assetKind)}不可用。`);
          send({ asset: serializeAsset(asset), type: "asset" });
        } catch (error) {
          logServerError(`bilibili.prepare.${assetKind}`, error);
          send({ asset: assetKind, error: `${assetLabel(assetKind)}准备失败。`, type: "asset-error" });
        }
      }));
      send({ type: "done" });
    } catch (error) {
      logServerError("bilibili.prepare", error);
      send({ error: "Bilibili DASH 资源准备失败，请稍后重试。", type: "error" });
    }
  });
}

function serializeAsset(asset: AvailableHistoryAsset): SerializedAsset {
  return {
    asset: asset.assetKind,
    contentType: asset.contentType,
    durationSeconds: asset.durationSeconds,
    objectKey: asset.objectKey,
    sizeBytes: asset.sizeBytes,
    url: asset.url,
    urlExpiresAt: asset.urlExpiresAt,
    verified: asset.assetKind === "originalAudio",
  };
}

function assetLabel(asset: HistoryAssetKind): string {
  if (asset === "avatar") return "作者头像";
  if (asset === "cover") return "作品封面";
  if (asset === "video") return "作品视频";
  return "原声";
}