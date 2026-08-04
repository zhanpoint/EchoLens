import { z } from "zod";
import { DASHSCOPE_MODEL_OPTIONS } from "@/lib/dashscope/model-config";

export const DashScopeModelIdsSchema = z.object({
  asrE1: z.enum(DASHSCOPE_MODEL_OPTIONS.asrE1),
  asrE2: z.enum(DASHSCOPE_MODEL_OPTIONS.asrE2),
  asrE3: z.enum(DASHSCOPE_MODEL_OPTIONS.asrE3).optional(),
  translation: z.enum(DASHSCOPE_MODEL_OPTIONS.translation),
  transcriptPostprocess: z.enum(DASHSCOPE_MODEL_OPTIONS.transcriptPostprocess),
  summary: z.enum(DASHSCOPE_MODEL_OPTIONS.summary),
}).strict();
