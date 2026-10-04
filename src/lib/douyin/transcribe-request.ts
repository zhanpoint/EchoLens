import type { ResolvedDouyinWork } from "@/types/douyin";

export type TranscribeWorkPayload = Pick<
  ResolvedDouyinWork,
  "authorName" | "authorUrl" | "caption" | "durationSeconds" | "finalUrl" | "id" | "inputUrl" | "kind" | "source"
>;
export type TranscribeHistoryContext = {
  historyRecordId: string;
  work: TranscribeWorkPayload;
};
