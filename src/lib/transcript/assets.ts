import {
  ensurePreparedAsset,
  type PreparedAsset,
  type PreparedAssetKind,
} from "@/lib/douyin/asset-bundle";
import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";
import { createOssSignedUrlWithExpiration, getOssObjectInfo } from "@/lib/oss/object-store";
import {
  readTranscriptHistoryAsset,
  readTranscriptHistoryRecord,
  upsertTranscriptHistoryAsset,
  type TranscriptHistoryAsset,
} from "@/lib/transcript/db";
import type { DouyinKind } from "@/types/douyin";

export type AvailableHistoryAsset = TranscriptHistoryAsset & {
  url: string;
  urlExpiresAt: number;
};

export async function ensureHistoryAsset(input: {
  assetKind: PreparedAssetKind;
  historyRecordId: string;
  userId: string;
}): Promise<AvailableHistoryAsset | null> {
  const history = await readTranscriptHistoryRecord({
    id: input.historyRecordId,
    userId: input.userId,
  });
  if (!history || history.workKind !== "video") return null;

  const stored = await readReusableHistoryAsset(input);
  if (stored) {
    return withSignedUrl(stored);
  }

  const lease = await acquireWorkMetadata({
    finalUrl: history.finalUrl,
    id: history.workId,
    kind: history.workKind as DouyinKind,
  });
  try {
    const prepared = await ensurePreparedAsset(
      { id: history.workId, kind: history.workKind as DouyinKind },
      lease.metadata,
      input.assetKind,
    );
    const saved = await savePreparedHistoryAsset({
      historyRecordId: history.id,
      prepared,
      userId: input.userId,
    });
    return saved ? withSignedUrl(saved) : null;
  } finally {
    lease.release();
  }
}

export async function readReusableHistoryAsset(input: {
  assetKind: PreparedAssetKind;
  historyRecordId: string;
  userId: string;
}): Promise<TranscriptHistoryAsset | null> {
  const stored = await readTranscriptHistoryAsset(input);
  if (!stored) return null;
  const info = await getOssObjectInfo(stored.objectKey);
  return info?.contentLength === stored.sizeBytes &&
    (input.assetKind !== "originalAudio" || Boolean(stored.verifiedAt))
    ? stored
    : null;
}

export async function savePreparedHistoryAsset(input: {
  historyRecordId: string;
  prepared: PreparedAsset;
  userId: string;
}): Promise<TranscriptHistoryAsset | null> {
  return await upsertTranscriptHistoryAsset({
    assetKind: input.prepared.asset,
    contentType: input.prepared.value.contentType,
    durationSeconds: input.prepared.asset === "originalAudio"
      ? input.prepared.value.durationSeconds
      : undefined,
    historyRecordId: input.historyRecordId,
    objectKey: input.prepared.value.objectKey,
    sizeBytes: input.prepared.value.sizeBytes,
    userId: input.userId,
    verifiedAt: input.prepared.asset === "originalAudio" ? Date.now() : undefined,
  });
}

export function withSignedUrl(asset: TranscriptHistoryAsset): AvailableHistoryAsset {
  const signed = createOssSignedUrlWithExpiration(asset.objectKey);
  return {
    ...asset,
    url: signed.url,
    urlExpiresAt: signed.expiresAt,
  };
}