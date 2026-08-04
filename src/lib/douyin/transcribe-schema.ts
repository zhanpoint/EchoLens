import { z } from "zod";
import type {
  TranscribeHistoryContext,
  TranscribeWorkPayload,
} from "@/lib/douyin/transcribe-request";
import { DOUYIN_KINDS } from "@/types/douyin";
import { MEDIA_SOURCES } from "@/lib/media/source";

export const TranscribeWorkSchema = z.object({
  authorName: z.string().optional(),
  authorUrl: z.string().optional(),
  caption: z.string().trim().min(1),
  durationSeconds: z.number().positive().optional(),
  finalUrl: z.string().url(),
  id: z.string().regex(/^(?:\d{6,30}|BV[\p{L}\p{N}]+:\d+)$/iu),
  inputUrl: z.string(),
  kind: z.enum(DOUYIN_KINDS),
  source: z.enum(MEDIA_SOURCES).optional(),
}).strict() satisfies z.ZodType<TranscribeWorkPayload>;

export const TranscribeHistoryContextSchema = z.object({
  historyRecordId: z.string().min(1).max(128),
  work: TranscribeWorkSchema,
}).strict() satisfies z.ZodType<TranscribeHistoryContext>;
