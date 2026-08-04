import {
  ensurePreparedAsset,
  type PreparedAsset,
  type PreparedAssetKind,
} from "@/lib/douyin/asset-bundle";
import {
  readBilibiliAudioQuality,
  readBilibiliStreamFormat,
  readBilibiliVideoCodec,
  readBilibiliVideoQuality,
  readDownloadVideoQuality,
} from "@/lib/download-settings";
import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";
import { readUserSetting } from "@/lib/user-settings";
import { createOssSignedUrlWithExpiration, getOssObjectInfo } from "@/lib/oss/object-store";
import {
  readTranscriptHistoryAsset,
  readTranscriptHistoryRecord,
  upsertTranscriptHistoryAsset,
  type TranscriptHistoryAsset,
} from "@/lib/transcript/db";
import type { DouyinKind } from "@/types/douyin";
import { readUsableBilibiliCookie } from "@/lib/bilibili/account";
import { ensureBilibiliAsset } from "@/lib/bilibili/assets";
import { buildBilibiliWorkId, resolveBilibiliWork } from "@/lib/bilibili/client";
import {
  buildBilibiliVideoCacheKey,
  ensureBilibiliVideoCached,
  readBilibiliVideoCache,
} from "@/lib/bilibili/video-cache";
import { mediaSourceFromWorkKey } from "@/lib/media/source";

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

  const source = mediaSourceFromWorkKey(history.workKey);
  if (source === "bilibili" && input.assetKind === "video") {
    return readBilibiliHistoryVideo({ history, userId: input.userId });
  }

  const stored = await readReusableHistoryAsset(input);
  if (stored) {
    return withSignedUrl(stored);
  }

  const downloadSettings = await readUserSetting(input.userId, "download");
  const videoQuality = readDownloadVideoQuality(downloadSettings);
  if (source === "bilibili") {
    if (input.assetKind === "video") return null;
    const bilibiliSettings = await readUserSetting(input.userId, "bilibili");
    const cookie = readUsableBilibiliCookie(bilibiliSettings);
    const { metadata, work } = await resolveBilibiliWork(history.finalUrl, cookie);
    if (work.id !== history.workId) return null;
    const prepared = await ensureBilibiliAsset({
      audioQuality: readBilibiliAudioQuality(downloadSettings),
      assetKind: input.assetKind,
      cookie,
      metadata,
      streamFormat: readBilibiliStreamFormat(downloadSettings),
    });
    const saved = await savePreparedHistoryAsset({
      historyRecordId: history.id,
      prepared,
      userId: input.userId,
    });
    return saved ? withSignedUrl(saved) : null;
  }
  const lease = await acquireWorkMetadata({
    finalUrl: history.finalUrl,
    id: history.workId,
    kind: history.workKind as DouyinKind,
  }, videoQuality);
  try {
    const prepared = await ensurePreparedAsset(
      { id: history.workId, kind: history.workKind as DouyinKind, videoQuality },
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

async function readBilibiliHistoryVideo(input: {
  history: {
    id: string;
    workId: string;
  };
  userId: string;
}): Promise<AvailableHistoryAsset | null> {
  const context = await readBilibiliVideoContext(input);
  const cached = await readBilibiliVideoCache(context.cacheKey);
  return cached ? toBilibiliVideoAsset(input.history.id, cached) : null;
}

export async function ensureBilibiliHistoryVideo(input: {
  historyRecordId: string;
  userId: string;
}): Promise<AvailableHistoryAsset | null> {
  const history = await readTranscriptHistoryRecord({ id: input.historyRecordId, userId: input.userId });
  if (!history || mediaSourceFromWorkKey(history.workKey) !== "bilibili") return null;
  const context = await readBilibiliVideoContext({ history, userId: input.userId });
  const bilibiliSettings = await readUserSetting(input.userId, "bilibili");
  const cookie = readUsableBilibiliCookie(bilibiliSettings);
  const { metadata, work } = await resolveBilibiliWork(history.finalUrl, cookie);
  if (buildBilibiliWorkId(metadata.bvid, metadata.cid) !== history.workId || work.id !== history.workId) return null;
  const cached = await ensureBilibiliVideoCached({
    cacheKey: context.cacheKey,
    cookie,
    metadata,
    options: context.options,
  });
  return toBilibiliVideoAsset(history.id, cached);
}

async function readBilibiliVideoContext(input: {
  history: { workId: string };
  userId: string;
}) {
  const downloadSettings = await readUserSetting(input.userId, "download");
  const options = {
    audioQuality: readBilibiliAudioQuality(downloadSettings),
    streamFormat: readBilibiliStreamFormat(downloadSettings),
    videoCodec: readBilibiliVideoCodec(downloadSettings),
    videoQuality: readBilibiliVideoQuality(downloadSettings),
  };
  return {
    cacheKey: buildBilibiliVideoCacheKey({
      options,
      userId: input.userId,
      workId: input.history.workId,
    }),
    options,
  };
}

function toBilibiliVideoAsset(historyRecordId: string, cached: {
  cacheKey: string;
  contentType: "video/mp4";
  expiresAt: number;
  sizeBytes: number;
}): AvailableHistoryAsset {
  return {
    assetKind: "video",
    contentType: cached.contentType,
    historyRecordId,
    objectKey: cached.cacheKey,
    sizeBytes: cached.sizeBytes,
    updatedAt: Date.now(),
    url: `/api/transcript-history/${encodeURIComponent(historyRecordId)}/assets/video/content`,
    urlExpiresAt: cached.expiresAt,
  };
}

export async function readBilibiliHistoryVideoFile(input: {
  historyRecordId: string;
  userId: string;
}) {
  const history = await readTranscriptHistoryRecord({ id: input.historyRecordId, userId: input.userId });
  if (!history || mediaSourceFromWorkKey(history.workKey) !== "bilibili") return null;
  const context = await readBilibiliVideoContext({ history, userId: input.userId });
  return readBilibiliVideoCache(context.cacheKey);
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
