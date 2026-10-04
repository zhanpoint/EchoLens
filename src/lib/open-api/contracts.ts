import { z } from "zod";

export const OpenMediaResolveSchema = z.object({
  inputs: z.array(z.string().min(1).max(5_000)).min(1).max(10),
}).strict();

export const OpenTranscriptionSchema = z.object({
  input: z.string().min(1).max(5_000),
  model: z.literal("e1").optional(),
}).strict();
