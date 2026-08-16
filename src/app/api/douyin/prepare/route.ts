import { NextResponse } from "next/server";
import { z } from "zod";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import { readDownloadVideoQuality } from "@/lib/download-settings";
import { markDouyinCredentialInvalid, readDouyinCredentialState } from "@/lib/douyin/account";
import {
  prepareDouyinSnapshotAsset,
  type AvailableHistoryAsset,
  type HistoryAssetKind,
} from "@/lib/transcript/assets";
import { DouyinMetadataError } from "@/lib/douyin/detail";
import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";
import { createJsonSseResponse } from "@/lib/http/sse-response";
import {
  createDouyinResourceSnapshot,
  snapshotHistoryMetadata,
} from "@/lib/media/resource-snapshot";
import { updateTranscriptHistoryRecordMetadata } from "@/lib/transcript/db";
import { readUserSetting } from "@/lib/user-settings";
import { DOUYIN_KINDS } from "@/types/douyin";

export const runtime = "nodejs";
export const maxDuration = 600;

const InputSchema = z.object({
  finalUrl: z.url().max(2_000),
  historyRecordId: z.string().min(1).max(128),
  id: z.string().regex(/^\d{6,30}$/),
  kind: z.enum(DOUYIN_KINDS),
});

const PREPARED_ASSETS = ["avatar", "cover", "video", "originalAudio", "dubbing"] as const satisfies readonly HistoryAssetKind[];

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
  | { asset: HistoryAssetKind; code?: string; error: string; type: "asset-error" }
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
  const credentialState = await readDouyinCredentialState(user.id);
  const credentialCookie = credentialState.status === "valid" ? credentialState.cookie : "";

  return createJsonSseResponse<PrepareEvent>(request.signal, async ({ send }) => {
    try {
      const lease = await acquireWorkMetadata(parsed.data, videoQuality, undefined, credentialCookie);
      try {
        const snapshot = createDouyinResourceSnapshot(lease.metadata, videoQuality);
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
            const asset = await prepareDouyinSnapshotAsset({
              assetKind,
              historyRecordId: history.id,
              metadata: lease.metadata,
              snapshot,
              userId: user.id,
              videoQuality,
              workId: parsed.data.id,
              workKey: history.workKey,
            });
            if (!asset) throw new Error(`${assetLabel(assetKind)}不可用。`);
            send({ asset: serializeAsset(asset), type: "asset" });
          } catch (error) {
            logServerError(`douyin.prepare.${assetKind}`, error);
            const networkFailure = error instanceof NetworkRetryExhaustedError;
            send({
              asset: assetKind,
              ...(networkFailure ? { code: NETWORK_RETRY_ERROR_CODE } : {}),
              error: networkFailure ? NETWORK_RETRY_ERROR_MESSAGE : `${assetLabel(assetKind)}准备失败。`,
              type: "asset-error",
            });
          }
        }));
        send({ type: "done" });
      } finally {
        lease.release();
      }
    } catch (error) {
      logServerError("douyin.prepare.metadata", error);
      const networkFailure = error instanceof NetworkRetryExhaustedError;
      const metadataFailure = error instanceof DouyinMetadataError;
      if (metadataFailure && error.code === "credential_invalid") {
        await markDouyinCredentialInvalid(user.id);
      }
      send({
        ...(networkFailure ? { code: NETWORK_RETRY_ERROR_CODE } : {}),
        ...(metadataFailure ? { code: error.code } : {}),
        error: networkFailure
          ? NETWORK_RETRY_ERROR_MESSAGE
          : metadataFailure
            ? error.message
            : "作品信息加载失败，请稍后重试。",
        type: "error",
      });
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
  if (asset === "dubbing") return "配音";
  return "原声";
}