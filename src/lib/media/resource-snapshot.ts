import type { BilibiliDashSelection, BilibiliWorkMetadata } from "@/lib/bilibili/client";
import type { DownloadVideoQuality } from "@/lib/download-settings";
import type { CompleteDouyinWorkMetadata } from "@/lib/douyin/detail";
import { inferSourceUrlsExpiresAt } from "@/lib/media/url-expiration";

export type MediaResourceSnapshot = {
  authorName: string;
  authorUrl?: string;
  avatarUrl?: string;
  caption: string;
  coverUrl?: string;
  dashAudioUrls: readonly string[];
  dashVideoUrls: readonly string[];
  dubbingTitle?: string;
  dubbingUrl?: string;
  durationSeconds: number;
  mediaQuality: string;
  progressiveVideoUrls: readonly string[];
  refreshedAt: number;
  source: "bilibili" | "douyin";
  urlsExpiresAt?: number;
};

export function createDouyinResourceSnapshot(
  metadata: CompleteDouyinWorkMetadata,
  mediaQuality: DownloadVideoQuality,
  refreshedAt = Date.now(),
): MediaResourceSnapshot {
  const snapshot = {
    authorName: metadata.authorName,
    authorUrl: metadata.authorUrl,
    avatarUrl: metadata.authorAvatarUrls[0],
    caption: metadata.caption,
    coverUrl: metadata.coverUrls[0],
    dashAudioUrls: metadata.audioUrls ?? [],
    dashVideoUrls: metadata.dashVideoUrls ?? [],
    dubbingTitle: metadata.dubbingTitle,
    dubbingUrl: metadata.dubbingAudioUrls?.[0],
    durationSeconds: metadata.durationSeconds,
    mediaQuality,
    progressiveVideoUrls: metadata.videoUrls,
    refreshedAt,
    source: "douyin" as const,
  };
  return {
    ...snapshot,
    urlsExpiresAt: inferSnapshotExpiration(snapshot, refreshedAt),
  };
}

export function createBilibiliResourceSnapshot(
  metadata: BilibiliWorkMetadata,
  selection: BilibiliDashSelection,
  refreshedAt = Date.now(),
): MediaResourceSnapshot {
  const snapshot = {
    authorName: metadata.authorName,
    authorUrl: metadata.authorUrl,
    avatarUrl: metadata.authorAvatarUrls[0],
    caption: metadata.caption,
    coverUrl: metadata.coverUrls[0],
    dashAudioUrls: selection.audio.urls,
    dashVideoUrls: selection.video.urls,
    durationSeconds: metadata.durationSeconds,
    mediaQuality: String(selection.video.id),
    progressiveVideoUrls: [] as readonly string[],
    refreshedAt,
    source: "bilibili" as const,
  };
  return {
    ...snapshot,
    urlsExpiresAt: inferSnapshotExpiration(snapshot, refreshedAt),
  };
}

export function snapshotHistoryMetadata(input: {
  historyRecordId: string;
  snapshot: MediaResourceSnapshot;
  userId: string;
}) {
  const { snapshot } = input;
  return {
    authorName: snapshot.authorName,
    authorUrl: snapshot.authorUrl,
    avatarUrl: snapshot.avatarUrl,
    caption: snapshot.caption,
    coverUrl: snapshot.coverUrl,
    dashVideoUrl: snapshot.dashVideoUrls[0],
    dubbingUrl: snapshot.dubbingUrl,
    durationSeconds: snapshot.durationSeconds,
    historyRecordId: input.historyRecordId,
    mediaQuality: snapshot.mediaQuality,
    sourceMetadataRefreshedAt: snapshot.refreshedAt,
    sourceUrlsExpiresAt: snapshot.urlsExpiresAt,
    userId: input.userId,
    videoUrl: snapshot.progressiveVideoUrls[0] ?? snapshot.dashVideoUrls[0],
  };
}

function inferSnapshotExpiration(
  snapshot: Omit<MediaResourceSnapshot, "urlsExpiresAt">,
  now: number,
): number | undefined {
  return inferSourceUrlsExpiresAt([
    snapshot.avatarUrl,
    snapshot.coverUrl,
    ...snapshot.progressiveVideoUrls,
    ...snapshot.dashVideoUrls,
    ...snapshot.dashAudioUrls,
    snapshot.dubbingUrl,
  ], now);
}