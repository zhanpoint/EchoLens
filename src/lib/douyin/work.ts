import {
  collectWorkMetadata,
  selectResolvedTitle,
  type DouyinWorkMetadata,
} from "@/lib/douyin/detail";
import { resolveDouyinInput } from "@/lib/douyin/url";
import type { ResolvedDouyinWork } from "@/types/douyin";

export type ResolvedWorkContext = {
  metadata: DouyinWorkMetadata;
  work: ResolvedDouyinWork;
};

export async function resolveInputWithMetadata(
  input: string,
  options?: { tolerateMetadataFailure?: boolean },
): Promise<ResolvedWorkContext> {
  const work = await resolveDouyinInput(input);
  const metadata: DouyinWorkMetadata = await collectWorkMetadata(work).catch((error: unknown) => {
    if (options?.tolerateMetadataFailure) {
      return {};
    }
    throw error;
  });

  return {
    metadata,
    work: {
      ...work,
      authorName: metadata.authorName,
      authorUrl: metadata.authorUrl,
      durationSeconds: metadata.durationSeconds,
      title: selectResolvedTitle(work.kind, metadata),
    },
  };
}
