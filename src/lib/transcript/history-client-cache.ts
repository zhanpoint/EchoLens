import {
  readClientSessionCache,
  writeClientSessionCache,
} from "@/lib/transcript/client-session-cache";

export const TRANSCRIPT_HISTORY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const HISTORY_LIST_CACHE_KEY = "history-list";
export const WORKFLOW_CACHE_KEY = "current-workflow";

export type TranscriptHistoryCache<T> = {
  records: T[];
  refreshedAt: number;
};

type HistoryListRecord = {
  transcriptContent: string;
  transcriptSegments?: unknown;
};

export function compactHistoryListRecords<T extends HistoryListRecord>(records: T[]): T[] {
  return records.map((record) => ({
    ...record,
    transcriptContent: "",
    transcriptSegments: undefined,
  }));
}

export function updateTranscriptHistoryCache<T extends HistoryListRecord>(
  userId: string,
  update: (records: T[]) => T[],
): void {
  void readClientSessionCache<TranscriptHistoryCache<T>>(userId, HISTORY_LIST_CACHE_KEY)
    .then((cached) => cached
      ? writeClientSessionCache(userId, HISTORY_LIST_CACHE_KEY, {
          records: compactHistoryListRecords(update(cached.records)),
          refreshedAt: Date.now(),
        } satisfies TranscriptHistoryCache<T>)
      : undefined)
    .catch(() => undefined);
}