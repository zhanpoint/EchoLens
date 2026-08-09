import {
  ensurePreparedAsset,
  type PreparedAsset,
  type PreparedAssetKind,
} from "@/lib/douyin/asset-bundle";
import {
  readBilibiliAudioQuality,
  readBilibiliVideoCodec,
  readBilibiliVideoQuality,
  readDownloadVideoQuality,
} from "@/lib/download-settings";
import { readUsableBilibiliCookie } from "@/lib/bilibili/account";
import {
  buildBilibiliWorkId,
  getBilibiliDashSelection,
  resolveBilibiliWork,
  type BilibiliMediaStream,
} from "@/lib/bilibili/client";
import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";
import { mediaSourceFromWorkKey } from "@/lib/media/source";
import { createOssSignedUrlWithExpiration, getOssObjectInfo } from "@/lib/oss/object-store";
import {
  readTranscriptHistoryAsset,
  readTranscriptHistoryRecord,
  upsertTranscriptHistoryAsset,
  type TranscriptHistoryAsset,
} from "@/lib/transcript/db";
import { readUserSetting } from "@/lib/user-settings";
import type { DouyinKind } from "@/types/douyin";

export type AvailableHistoryAsset = {
  assetKind: PreparedAssetKind | "avatar";
  contentType: string;
  durationSeconds?: number;
  historyRecordId: string;
  objectKey: string;
  sizeBytes: number;
  updatedAt: number;
  url: string;
  urlExpiresAt: number;
  verifiedAt?: number;
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
  if (source === "bilibili") {
    return await resolveBilibiliHistoryAsset({ history, assetKind: input.assetKind, userId: input.userId });
  }

  const stored = await readReusableHistoryAsset(input);
  if (stored) return withSignedUrl(stored);

  const downloadSettings = await readUserSetting(input.userId, "download");
  const videoQuality = readDownloadVideoQuality(downloadSettings);
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

export async function ensureBilibiliHistoryVideo(input: {
  historyRecordId: string;
  userId: string;
}): Promise<AvailableHistoryAsset | null> {
  const history = await readTranscriptHistoryRecord({ id: input.historyRecordId, userId: input.userId });
  if (!history || mediaSourceFromWorkKey(history.workKey) !== "bilibili") return null;
  return await resolveBilibiliHistoryAsset({ history, assetKind: "video", userId: input.userId });
}

async function resolveBilibiliHistoryAsset(input: {
  assetKind: PreparedAssetKind | "avatar";
  history: {
    finalUrl: string;
    id: string;
    workId: string;
  };
  userId: string;
}): Promise<AvailableHistoryAsset | null> {
  const bilibiliSettings = await readUserSetting(input.userId, "bilibili");
  const downloadSettings = await readUserSetting(input.userId, "download");
  const cookie = readUsableBilibiliCookie(bilibiliSettings);
  const { metadata, work } = await resolveBilibiliWork(input.history.finalUrl, cookie);
  if (buildBilibiliWorkId(metadata.bvid, metadata.cid) !== input.history.workId || work.id !== input.history.workId) {
    return null;
  }

  const base = {
    historyRecordId: input.history.id,
    sizeBytes: 0,
    updatedAt: Date.now(),
    urlExpiresAt: Date.now() + 15 * 60_000,
  };
  if (input.assetKind === "avatar") {
    const url = metadata.authorAvatarUrls[0];
    return url ? { ...base, assetKind: "avatar", contentType: "image/jpeg", objectKey: `bilibili:${work.id}:avatar`, url } : null;
  }
  if (input.assetKind === "cover") {
    const url = metadata.coverUrls[0];
    return url ? { ...base, assetKind: "cover", contentType: "image/jpeg", objectKey: `bilibili:${work.id}:cover`, url } : null;
  }

  const selection = await getBilibiliDashSelection({
    audioQuality: readBilibiliAudioQuality(downloadSettings),
    bvid: metadata.bvid,
    cid: metadata.cid,
    codec: readBilibiliVideoCodec(downloadSettings),
    cookie,
    videoQuality: readBilibiliVideoQuality(downloadSettings),
  });
  if (input.assetKind === "originalAudio") {
    return dashAsset({
      ...base,
      assetKind: "originalAudio",
      contentType: contentTypeForAudio(selection.audio),
      durationSeconds: metadata.durationSeconds,
      objectKey: `bilibili:${work.id}:audio:${selection.audio.id}`,
      stream: selection.audio,
      verifiedAt: Date.now(),
    });
  }
  return dashAsset({
    ...base,
    assetKind: "video",
    contentType: contentTypeForVideo(),
    objectKey: `bilibili:${work.id}:video:${selection.video.id}:${selection.video.codecId ?? "unknown"}`,
    stream: selection.video,
  });
}

function dashAsset(input: Omit<AvailableHistoryAsset, "url"> & { stream: BilibiliMediaStream }): AvailableHistoryAsset | null {
  const url = input.stream.urls[0];
  if (!url) return null;
  return {
    assetKind: input.assetKind,
    contentType: input.contentType,
    durationSeconds: input.durationSeconds,
    historyRecordId: input.historyRecordId,
    objectKey: input.objectKey,
    sizeBytes: input.sizeBytes,
    updatedAt: input.updatedAt,
    url,
    urlExpiresAt: input.urlExpiresAt,
    verifiedAt: input.verifiedAt,
  };
}

function contentTypeForAudio(stream: BilibiliMediaStream): string {
  if (stream.id === 30251) return "audio/flac";
  if (stream.id === 30250) return "audio/eac3";
  return "audio/mp4";
}

function contentTypeForVideo(): string {
  return "video/mp4";
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