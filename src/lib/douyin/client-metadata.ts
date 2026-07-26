import type { ResolvedDouyinWork } from "@/types/douyin";

export type WorkMetadataPatch = {
  authorName?: string;
  authorUrl?: string;
  durationSeconds?: number;
};

export function mergeWorkMetadata(
  work: ResolvedDouyinWork,
  metadata: WorkMetadataPatch,
): ResolvedDouyinWork {
  return {
    ...work,
    authorName: metadata.authorName ?? work.authorName,
    authorUrl: metadata.authorUrl ?? work.authorUrl,
    durationSeconds: metadata.durationSeconds ?? work.durationSeconds,
  };
}
