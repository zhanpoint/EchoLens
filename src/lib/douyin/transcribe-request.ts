import type { ResolvedDouyinWork } from "@/types/douyin";

export type TranscribeWorkPayload = Pick<
  ResolvedDouyinWork,
  "authorName" | "authorUrl" | "caption" | "durationSeconds" | "finalUrl" | "id" | "inputUrl" | "kind"
>;
export type TranscribeHistoryContext = {
  historyRecordId: string;
  work: TranscribeWorkPayload;
};

export function buildTranscribeWorkPayload(work: ResolvedDouyinWork): TranscribeWorkPayload {
  return {
    authorName: work.authorName,
    authorUrl: work.authorUrl,
    caption: work.caption,
    durationSeconds: work.durationSeconds,
    finalUrl: work.finalUrl,
    id: work.id,
    inputUrl: work.inputUrl,
    kind: work.kind,
  };
}
