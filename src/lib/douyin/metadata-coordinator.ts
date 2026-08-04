import {
  collectWorkMetadata,
  type CompleteDouyinWorkMetadata,
  type DouyinWorkMetadata,
} from "./detail";
import {
  DEFAULT_DOWNLOAD_VIDEO_QUALITY,
  type DownloadVideoQuality,
} from "@/lib/download-settings";
import type { DouyinWorkIdentity } from "@/types/douyin";

type MetadataWork = Pick<DouyinWorkIdentity, "finalUrl" | "id" | "kind">;
type MetadataEntry = {
  cleanupTimer?: ReturnType<typeof setTimeout>;
  metadata?: CompleteDouyinWorkMetadata;
  references: number;
  result: Promise<CompleteDouyinWorkMetadata>;
};

export type WorkMetadataLease = {
  metadata: CompleteDouyinWorkMetadata;
  release: () => void;
};

const entries = new Map<string, MetadataEntry>();
const METADATA_HANDOFF_TTL_MS = 30_000;

export async function acquireWorkMetadata(
  work: MetadataWork,
  videoQuality: DownloadVideoQuality = DEFAULT_DOWNLOAD_VIDEO_QUALITY,
): Promise<WorkMetadataLease> {
  const key = `${work.kind}:${work.id}:${videoQuality}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = { references: 0, result: collectWorkMetadata(work, { videoQuality }) };
    entries.set(key, entry);
    void entry.result.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
  }
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = undefined;
  }
  entry.references += 1;

  try {
    const metadata = await entry.result;
    entry.metadata = metadata;
    let released = false;
    return {
      metadata,
      release() {
        if (released) return;
        released = true;
        releaseEntry(key, entry);
      },
    };
  } catch (error) {
    releaseEntry(key, entry);
    throw error;
  }
}

function releaseEntry(key: string, entry: MetadataEntry): void {
  entry.references = Math.max(0, entry.references - 1);
  if (entries.get(key) !== entry || entry.references > 0 || entry.cleanupTimer) return;
  entry.cleanupTimer = setTimeout(() => {
    if (entry.references > 0 || entries.get(key) !== entry) return;
    entries.delete(key);
    if (entry.metadata) clearOriginalMediaUrls(entry.metadata);
    entry.metadata = undefined;
    entry.cleanupTimer = undefined;
  }, METADATA_HANDOFF_TTL_MS);
  entry.cleanupTimer.unref?.();
}

function clearOriginalMediaUrls(metadata: CompleteDouyinWorkMetadata): void {
  const releasedMetadata: DouyinWorkMetadata = metadata;
  metadata.authorAvatarUrls.fill("");
  metadata.coverUrls.fill("");
  metadata.videoUrls.fill("");
  releasedMetadata.authorAvatarUrls = undefined;
  releasedMetadata.coverUrls = undefined;
  releasedMetadata.videoUrls = undefined;
}
