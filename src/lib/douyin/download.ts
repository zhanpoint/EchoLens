import type { DouyinKind, MediaAssetKind } from "@/types/douyin";

export function buildMediaDownloadPath(
  work: { id: string; kind: DouyinKind },
  asset: MediaAssetKind,
  options?: { preview?: boolean },
): string {
  const params = new URLSearchParams({
    id: work.id,
    kind: work.kind,
    asset,
  });

  if (options?.preview) {
    params.set("preview", "1");
  }

  return `/api/douyin/download?${params.toString()}`;
}

export function buildDouyinWorkUrl(kind: DouyinKind, id: string): string {
  return new URL(`/${kind}/${id}`, "https://www.douyin.com").toString();
}

export function canDownloadAsset(kind: DouyinKind, asset: MediaAssetKind): boolean {
  return (asset !== "video" && asset !== "originalAudio") || kind === "video";
}

export function isSupportedMediaUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
