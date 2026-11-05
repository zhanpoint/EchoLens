import { z } from "zod";
import { DASHSCOPE_MODEL_OPTIONS } from "@/lib/dashscope/model-config";

export const DashScopeModelIdsSchema = z.object({
  asr: z.enum(DASHSCOPE_MODEL_OPTIONS.asr),
  translation: z.enum(DASHSCOPE_MODEL_OPTIONS.translation),
  transcriptPostprocess: z.enum(DASHSCOPE_MODEL_OPTIONS.transcriptPostprocess),
  summary: z.enum(DASHSCOPE_MODEL_OPTIONS.summary),
}).strict();
