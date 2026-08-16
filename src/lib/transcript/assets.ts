import { fetchRemoteMedia } from "@/lib/media/audio";
import { ensureTemporaryMuxedVideo } from "@/lib/media/temporary-video-cache";
import { sourceUrlsNeedRefresh } from "@/lib/media/url-expiration";
import {
  createBilibiliResourceSnapshot,
  createDouyinResourceSnapshot,
  snapshotHistoryMetadata,
  type MediaResourceSnapshot,
} from "@/lib/media/resource-snapshot";
import {
  createOssSignedUrlWithExpiration,
  getOssObjectInfo,
  putOssStream,
} from "@/lib/oss/object-store";
import {
  readBilibiliAudioQuality,
  readBilibiliVideoCodec,
  readBilibiliVideoQuality,
  readDownloadVideoQuality,
  type DownloadVideoQuality,
} from "@/lib/download-settings";
import { readUsableBilibiliCookie } from "@/lib/bilibili/account";
import { readDouyinCredentialState } from "@/lib/douyin/account";
import {
  getBilibiliDashSelection,
  resolveBilibiliWork,
  type BilibiliDashSelection,
  type BilibiliMediaStream,
  type BilibiliWorkMetadata,
} from "@/lib/bilibili/client";
import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";
import {
  douyinOriginalAudioObjectKey,
  prepareDouyinOriginalAudio,
} from "@/lib/douyin/asset-bundle";
import type { CompleteDouyinWorkMetadata } from "@/lib/douyin/detail";
import type { MediaAssetKind } from "@/types/douyin";
import { mediaSourceFromWorkKey } from "@/lib/media/source";
import {
  readTranscriptHistoryRecord,
  updateTranscriptHistoryRecordMetadata,
  type TranscriptHistoryRecord,
} from "@/lib/transcript/db";
import { readUserSetting } from "@/lib/user-settings";

export type HistoryAssetKind = "avatar" | MediaAssetKind;
export type UpstreamHistoryAssetKind = Exclude<HistoryAssetKind, "originalAudio">;

export type AvailableHistoryAsset = {
  assetKind: HistoryAssetKind | "avatar";
  contentType: string;
  durationSeconds?: number;
  historyRecordId: string;
  objectKey?: string;
  sizeBytes: number;
  updatedAt: number;
  url: string;
  urlExpiresAt?: number;
  verifiedAt?: number;
};

type AssetContext = {
  historyRecordId: string;
  snapshot: MediaResourceSnapshot;
  userId: string;
  workId: string;
  workKey: string;
};

export async function ensureHistoryAsset(input: {
  assetKind: HistoryAssetKind;
  forceRefresh?: boolean;
  historyRecordId: string;
  userId: string;
}): Promise<AvailableHistoryAsset | null> {
  const history = await readTranscriptHistoryRecord({ id: input.historyRecordId, userId: input.userId });
  if (!history || history.workKind !== "video") return null;

  const storedAudio = input.assetKind === "originalAudio"
    ? await readStoredOriginalAudio(history)
    : null;
  if (storedAudio) return storedAudio;

  const reusable = readReusableUpstreamAsset(history, input.assetKind, input.forceRefresh === true);
  if (reusable) return reusable;

  return mediaSourceFromWorkKey(history.workKey) === "bilibili"
    ? await refreshBilibiliAsset(history, input.assetKind, input.userId)
    : await refreshDouyinAsset(history, input.assetKind, input.userId);
}

export async function readHistoryUpstreamAssets(input: {
  historyRecordId: string;
  userId: string;
}): Promise<Partial<Record<UpstreamHistoryAssetKind, AvailableHistoryAsset>> | null> {
  const history = await readTranscriptHistoryRecord({ id: input.historyRecordId, userId: input.userId });
  if (!history || history.workKind !== "video") return null;
  const snapshot = historySnapshotAssets(history);
  return Object.keys(snapshot).length ? snapshot : null;
}

export async function prepareDouyinSnapshotAsset(input: AssetContext & {
  assetKind: HistoryAssetKind;
  metadata: CompleteDouyinWorkMetadata;
  videoQuality: DownloadVideoQuality;
}): Promise<AvailableHistoryAsset | null> {
  const direct = readSnapshotDirectAsset(input.snapshot, input.assetKind, input.historyRecordId);
  if (direct) return direct;

  if (input.assetKind === "video") {
    return await prepareTemporaryVideoAsset({
      fallbackUrl: input.snapshot.progressiveVideoUrls[0],
      historyRecordId: input.historyRecordId,
      snapshot: input.snapshot,
      workKey: input.workKey,
    });
  }

  const objectKey = douyinOriginalAudioObjectKey({ id: input.workId, kind: "video" });
  const existing = await readOriginalAudioObject(
    input.historyRecordId,
    objectKey,
    input.snapshot.durationSeconds,
    input.snapshot.refreshedAt,
  );
  if (existing) {
    await persistOriginalAudio(input, objectKey);
    return existing;
  }

  const prepared = await prepareDouyinOriginalAudio(
    { id: input.workId, kind: "video", videoQuality: input.videoQuality },
    input.metadata,
  );
  await persistOriginalAudio(input, prepared.objectKey);
  return signedOriginalAudioAsset(input.historyRecordId, prepared, input.snapshot.refreshedAt);
}

export async function prepareBilibiliSnapshotAsset(input: AssetContext & {
  assetKind: HistoryAssetKind;
  metadata: BilibiliWorkMetadata;
  selection: BilibiliDashSelection;
}): Promise<AvailableHistoryAsset | null> {
  const direct = readSnapshotDirectAsset(input.snapshot, input.assetKind, input.historyRecordId);
  if (direct) return direct;

  if (input.assetKind === "video") {
    return await prepareTemporaryVideoAsset({
      historyRecordId: input.historyRecordId,
      snapshot: input.snapshot,
      workKey: input.workKey,
    });
  }

  const originalAudio = await ensureBilibiliOriginalAudio(input.workId, input.selection.audio);
  await persistOriginalAudio(input, originalAudio.objectKey);
  return signedOriginalAudioAsset(input.historyRecordId, {
    ...originalAudio,
    durationSeconds: input.metadata.durationSeconds,
  }, input.snapshot.refreshedAt);
}

async function prepareTemporaryVideoAsset(input: {
  fallbackUrl?: string;
  historyRecordId: string;
  snapshot: MediaResourceSnapshot;
  workKey: string;
}): Promise<AvailableHistoryAsset | null> {
  if (!input.snapshot.dashVideoUrls.length || !input.snapshot.dashAudioUrls.length) {
    return input.fallbackUrl
      ? upstreamAsset(input.historyRecordId, "video", input.fallbackUrl, input.snapshot)
      : null;
  }

  try {
    const temporary = await ensureTemporaryMuxedVideo({
      audioUrls: input.snapshot.dashAudioUrls,
      cacheIdentity: `${input.workKey}:${input.snapshot.mediaQuality}`,
      mediaSource: input.snapshot.source,
      videoUrls: input.snapshot.dashVideoUrls,
    });
    return {
      assetKind: "video",
      contentType: "video/mp4",
      durationSeconds: input.snapshot.durationSeconds,
      historyRecordId: input.historyRecordId,
      sizeBytes: temporary.sizeBytes,
      updatedAt: Date.now(),
      url: temporaryVideoUrl(input.historyRecordId, temporary.cacheKey),
      urlExpiresAt: temporary.expiresAt,
    };
  } catch {
    return input.fallbackUrl
      ? upstreamAsset(input.historyRecordId, "video", input.fallbackUrl, input.snapshot)
      : null;
  }
}

async function refreshDouyinAsset(
  history: TranscriptHistoryRecord,
  assetKind: HistoryAssetKind,
  userId: string,
): Promise<AvailableHistoryAsset | null> {
  const [settings, credentialState] = await Promise.all([
    readUserSetting(userId, "download"),
    readDouyinCredentialState(userId),
  ]);
  const videoQuality = readDownloadVideoQuality(settings);
  const lease = await acquireWorkMetadata(
    { finalUrl: history.finalUrl, id: history.workId, kind: "video" },
    videoQuality,
    undefined,
    credentialState.status === "valid" ? credentialState.cookie : "",
  );
  try {
    const snapshot = createDouyinResourceSnapshot(lease.metadata, videoQuality);
    await persistSnapshot(history.id, userId, snapshot);
    return await prepareDouyinSnapshotAsset({
      assetKind,
      historyRecordId: history.id,
      metadata: lease.metadata,
      snapshot,
      userId,
      videoQuality,
      workId: history.workId,
      workKey: history.workKey,
    });
  } finally {
    lease.release();
  }
}

async function refreshBilibiliAsset(
  history: TranscriptHistoryRecord,
  assetKind: HistoryAssetKind,
  userId: string,
): Promise<AvailableHistoryAsset | null> {
  const [bilibiliSettings, downloadSettings] = await Promise.all([
    readUserSetting(userId, "bilibili"),
    readUserSetting(userId, "download"),
  ]);
  const cookie = readUsableBilibiliCookie(bilibiliSettings);
  const { metadata } = await resolveBilibiliWork(history.finalUrl, cookie);
  const selection = await getBilibiliDashSelection({
    audioQuality: readBilibiliAudioQuality(downloadSettings),
    bvid: metadata.bvid,
    cid: metadata.cid,
    codec: readBilibiliVideoCodec(downloadSettings),
    cookie,
    videoQuality: readBilibiliVideoQuality(downloadSettings),
  });
  const snapshot = createBilibiliResourceSnapshot(metadata, selection);
  await persistSnapshot(history.id, userId, snapshot);
  return await prepareBilibiliSnapshotAsset({
    assetKind,
    historyRecordId: history.id,
    metadata,
    selection,
    snapshot,
    userId,
    workId: history.workId,
    workKey: history.workKey,
  });
}

async function persistSnapshot(
  historyRecordId: string,
  userId: string,
  snapshot: MediaResourceSnapshot,
): Promise<TranscriptHistoryRecord | null> {
  return await updateTranscriptHistoryRecordMetadata(
    snapshotHistoryMetadata({ historyRecordId, snapshot, userId }),
  );
}

async function persistOriginalAudio(input: AssetContext, objectKey: string): Promise<void> {
  await updateTranscriptHistoryRecordMetadata({
    ...snapshotHistoryMetadata(input),
    originalAudio: objectKey,
  });
}

async function readStoredOriginalAudio(
  history: TranscriptHistoryRecord,
): Promise<AvailableHistoryAsset | null> {
  if (!history.originalAudio) return null;
  return await readOriginalAudioObject(
    history.id,
    history.originalAudio,
    history.durationSeconds,
    history.sourceMetadataRefreshedAt,
    history.updatedAt,
  );
}

async function readOriginalAudioObject(
  historyRecordId: string,
  objectKey: string,
  durationSeconds: number | undefined,
  verifiedAt: number | undefined,
  updatedAt = Date.now(),
): Promise<AvailableHistoryAsset | null> {
  const info = await getOssObjectInfo(objectKey);
  if (!info?.contentLength) return null;
  const signed = createOssSignedUrlWithExpiration(objectKey);
  return {
    assetKind: "originalAudio",
    contentType: info.contentType || "audio/mp4",
    durationSeconds,
    historyRecordId,
    objectKey,
    sizeBytes: info.contentLength,
    updatedAt,
    url: signed.url,
    urlExpiresAt: signed.expiresAt,
    verifiedAt,
  };
}

function readReusableUpstreamAsset(
  history: TranscriptHistoryRecord,
  assetKind: HistoryAssetKind,
  forceRefresh: boolean,
): AvailableHistoryAsset | null {
  if (
    forceRefresh
    || assetKind === "originalAudio"
    || assetKind === "video"
    || sourceUrlsNeedRefresh(history.sourceUrlsExpiresAt)
  ) return null;
  const url = assetKind === "avatar"
    ? history.avatarUrl
    : assetKind === "cover"
      ? history.coverUrl
      : assetKind === "dubbing"
        ? history.dubbingUrl
        : undefined;
  return url ? {
    assetKind,
    contentType: "image/jpeg",
    historyRecordId: history.id,
    sizeBytes: 0,
    updatedAt: history.sourceMetadataRefreshedAt ?? history.updatedAt,
    url,
    urlExpiresAt: history.sourceUrlsExpiresAt,
  } : null;
}

function historySnapshotAssets(
  history: TranscriptHistoryRecord,
): Partial<Record<UpstreamHistoryAssetKind, AvailableHistoryAsset>> {
  const timestamp = history.sourceMetadataRefreshedAt ?? history.updatedAt;
  return {
    ...(history.avatarUrl ? {
      avatar: {
        assetKind: "avatar",
        contentType: "image/jpeg",
        historyRecordId: history.id,
        sizeBytes: 0,
        updatedAt: timestamp,
        url: history.avatarUrl,
        urlExpiresAt: history.sourceUrlsExpiresAt,
      },
    } : {}),
    ...(history.coverUrl ? {
      cover: {
        assetKind: "cover",
        contentType: "image/jpeg",
        historyRecordId: history.id,
        sizeBytes: 0,
        updatedAt: timestamp,
        url: history.coverUrl,
        urlExpiresAt: history.sourceUrlsExpiresAt,
      },
    } : {}),
    ...(history.dubbingUrl ? {
      dubbing: {
        assetKind: "dubbing" as const,
        contentType: "audio/mp4",
        durationSeconds: history.durationSeconds,
        historyRecordId: history.id,
        sizeBytes: 0,
        updatedAt: timestamp,
        url: history.dubbingUrl,
        urlExpiresAt: history.sourceUrlsExpiresAt,
      },
    } : {}),
    ...(history.videoUrl ? {
      video: {
        assetKind: "video",
        contentType: "video/mp4",
        durationSeconds: history.durationSeconds,
        historyRecordId: history.id,
        sizeBytes: 0,
        updatedAt: timestamp,
        url: history.videoUrl,
        urlExpiresAt: history.sourceUrlsExpiresAt,
      },
    } : {}),
  };
}

function readSnapshotDirectAsset(
  snapshot: MediaResourceSnapshot,
  assetKind: HistoryAssetKind,
  historyRecordId: string,
): AvailableHistoryAsset | null {
  if (assetKind !== "avatar" && assetKind !== "cover" && assetKind !== "dubbing") return null;
  const url = assetKind === "avatar"
    ? snapshot.avatarUrl
    : assetKind === "cover"
      ? snapshot.coverUrl
      : snapshot.dubbingUrl;
  return url ? upstreamAsset(historyRecordId, assetKind, url, snapshot) : null;
}

function upstreamAsset(
  historyRecordId: string,
  assetKind: "avatar" | "cover" | "dubbing" | "video",
  url: string,
  snapshot: MediaResourceSnapshot,
): AvailableHistoryAsset {
  const isAudio = assetKind === "dubbing";
  const isVideo = assetKind === "video";
  return {
    assetKind,
    contentType: isVideo ? "video/mp4" : isAudio ? "audio/mp4" : "image/jpeg",
    ...(isAudio || isVideo ? { durationSeconds: snapshot.durationSeconds } : {}),
    historyRecordId,
    sizeBytes: 0,
    updatedAt: snapshot.refreshedAt,
    url,
    urlExpiresAt: snapshot.urlsExpiresAt,
  };
}

async function ensureBilibiliOriginalAudio(
  workId: string,
  stream: BilibiliMediaStream,
): Promise<{ contentType: string; objectKey: string; sizeBytes: number }> {
  const objectKey = `echolens/media/video/${workId}/audio.${audioExtension(stream)}`;
  const existing = await getOssObjectInfo(objectKey);
  if (existing?.contentLength) {
    return {
      contentType: existing.contentType || contentTypeForAudio(stream),
      objectKey,
      sizeBytes: existing.contentLength,
    };
  }

  const response = await fetchRemoteMedia(stream.urls, { mediaSource: "bilibili" });
  try {
    await putOssStream({
      body: response.body!,
      cacheControl: "no-cache",
      contentLength: positiveContentLength(response),
      contentType: contentTypeForAudio(stream),
      objectKey,
    });
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
  const stored = await getOssObjectInfo(objectKey);
  if (!stored?.contentLength) throw new Error("Bilibili 原声音频上传失败。");
  return {
    contentType: stored.contentType || contentTypeForAudio(stream),
    objectKey,
    sizeBytes: stored.contentLength,
  };
}

function signedOriginalAudioAsset(
  historyRecordId: string,
  audio: { contentType: string; durationSeconds: number; objectKey: string; sizeBytes: number },
  verifiedAt: number,
): AvailableHistoryAsset {
  const signed = createOssSignedUrlWithExpiration(audio.objectKey);
  return {
    assetKind: "originalAudio",
    contentType: audio.contentType,
    durationSeconds: audio.durationSeconds,
    historyRecordId,
    objectKey: audio.objectKey,
    sizeBytes: audio.sizeBytes,
    updatedAt: Date.now(),
    url: signed.url,
    urlExpiresAt: signed.expiresAt,
    verifiedAt,
  };
}

function temporaryVideoUrl(historyRecordId: string, cacheKey: string): string {
  return `/api/media/temporary-video?historyRecordId=${encodeURIComponent(historyRecordId)}&cacheKey=${cacheKey}`;
}

function positiveContentLength(response: Response): number | undefined {
  const value = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function audioExtension(stream: BilibiliMediaStream): string {
  if (stream.id === 30251) return "flac";
  if (stream.id === 30250) return "eac3";
  return "m4a";
}

function contentTypeForAudio(stream: BilibiliMediaStream): string {
  if (stream.id === 30251) return "audio/flac";
  if (stream.id === 30250) return "audio/eac3";
  return "audio/mp4";
}