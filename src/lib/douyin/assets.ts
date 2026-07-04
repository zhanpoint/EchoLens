import type { DouyinWorkMetadata } from "@/lib/douyin/detail";
import type { MediaAssetKind } from "@/types/douyin";

export function buildWorkCacheKey(work: { id: string; kind: string }): string {
  return `${work.kind}:${work.id}`;
}

export function buildWorkMediaCacheKey(work: { id: string; kind: string }, asset: MediaAssetKind): string {
  return `${buildWorkCacheKey(work)}:${asset}`;
}

export function selectMediaAssetUrls(asset: MediaAssetKind, metadata: DouyinWorkMetadata): string[] {
  if (asset === "cover") {
    return metadata.coverUrls ?? [];
  }

  return metadata.videoUrls ?? [];
}
