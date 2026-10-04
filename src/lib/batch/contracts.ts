import { z } from "zod";

export const PlatformSchema = z.enum(["douyin", "bilibili"]);
export type BatchPlatform = z.infer<typeof PlatformSchema>;
export const AuthorVideoSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(2000),
  coverUrl: z.string().max(2000).default(""),
  durationSeconds: z.number().nonnegative().default(0),
  publishedAt: z.number().nonnegative().default(0),
  tags: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
});
export type AuthorVideo = z.infer<typeof AuthorVideoSchema>;
export type AuthorVideoPage = {
  authorId: string;
  authorName: string;
  videos: AuthorVideo[];
  cursor: string | null;
  total?: number;
};

export const ExportFormatSchema = z.enum(["md", "txt", "json"]);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;
export type BatchExportRow = { position: number; video: AuthorVideo; transcript: string };
export const CreateBatchSchema = z.object({
  platform: PlatformSchema,
  authorName: z.string().trim().max(200).default(""),
  model: z.literal("e1").default("e1"),
  videos: z.array(AuthorVideoSchema).min(1).max(5000),
});
export type BatchStatus = "running" | "paused" | "completed" | "canceled";
export type BatchItemStatus =
  "queued" | "processing" | "waiting" | "succeeded" | "skipped" | "failed" | "canceled";
export type BatchJob = {
  id: string;
  platform: BatchPlatform;
  authorName: string;
  model: "e1";
  status: BatchStatus;
  createdAt: number;
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  processing: number;
  interrupted: number;
  canceled: number;
};
export type BatchItem = {
  id: string;
  position: number;
  video: AuthorVideo;
  status: BatchItemStatus;
  stage: string;
  error: string | null;
  historyRecordId: string | null;
  interrupted: boolean;
};
export type BatchDetail = {
  job: BatchJob;
  items: BatchItem[];
  total: number;
  offset: number;
};

export function videoUrl(platform: BatchPlatform, id: string): string {
  if (platform === "douyin" && /^\d{6,30}$/.test(id))
    return `https://www.douyin.com/video/${id}`;
  if (platform === "bilibili" && /^BV[\p{L}\p{N}]+$/iu.test(id))
    return `https://www.bilibili.com/video/${id}`;
  throw new Error("视频标识无效。");
}
