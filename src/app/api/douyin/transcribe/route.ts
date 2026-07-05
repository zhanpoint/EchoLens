import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import type { ProviderResult } from "@/lib/ai/provider-result";
import {
  cancelDashScopeAsrJob,
  DailyAsrQuotaExceededError,
  getDashScopeAsrModelForProfile,
  refreshDashScopeAsrJobWithOptions,
  transcribeDashScopeAsr,
  type DashScopeAsrJobResult,
  type DashScopeAsrModelProfile,
  type DashScopeAsrModel,
} from "@/lib/dashscope/asr";
import { isManagedAsrAudioUrl } from "@/lib/oss/asr-audio";
import { readAsrAudioCache, upsertTranscriptHistoryRecord, type TranscriptHistoryRecord } from "@/lib/transcript/db";
import { withUserRouteConcurrency } from "@/lib/user-concurrency";
import {
  DOUYIN_KINDS,
  TRANSCRIPT_FEATURE,
  getFeatureLabel,
  type ExtractionResult,
} from "@/types/douyin";

export const runtime = "nodejs";

const E1_ASR_PROFILE: DashScopeAsrModelProfile = "e1";
const E2_ASR_PROFILE: DashScopeAsrModelProfile = "e2";

const SensitiveWordListSchema = z.object({
  word_list: z.array(z.string().trim().min(1)),
}).strict();

const SpecialWordFilterSchema = z.object({
  filter_with_empty: SensitiveWordListSchema.optional(),
  filter_with_signed: SensitiveWordListSchema.optional(),
  system_reserved_filter: z.boolean().optional(),
}).strict();

const WorkSchema = z.object({
  authorName: z.string().optional(),
  authorUrl: z.string().optional(),
  finalUrl: z.string().url(),
  id: z.string().regex(/^\d{6,30}$/),
  inputUrl: z.string(),
  kind: z.enum(DOUYIN_KINDS),
  durationSeconds: z.number().positive().optional(),
  title: z.string().optional(),
}).strict();

const HistoryWorkSchema = WorkSchema.extend({
  historyRecordId: z.string().min(1).max(128),
}).strict();

const TranscribeSchema = z.object({
  audioObjectKey: z.string().min(1).max(512),
  audioUrl: z.string().url().max(4096),
  clientJobId: z.string().min(1).max(128).optional(),
  historyRecordId: z.string().min(1).max(128).optional(),
  diarizationEnabled: z.boolean().optional(),
  enableItn: z.boolean().optional(),
  model: z.enum([E1_ASR_PROFILE, E2_ASR_PROFILE]).optional(),
  specialWordFilter: SpecialWordFilterSchema.optional(),
  speakerCount: z.coerce.number().int().min(1).max(10).optional(),
  work: WorkSchema,
}).strict();

const ReadJobSchema = z.object({
  jobId: z.string().min(1).max(128),
}).strict();

type TranscribeStreamEvent =
  | { type: "running"; jobId: string; work?: z.infer<typeof WorkSchema> }
  | { type: "postprocess_start"; work?: z.infer<typeof WorkSchema> }
  | { type: "delta"; value: string }
  | {
      type: "done";
      historyRecord?: TranscriptHistoryRecord;
      results: ExtractionResult[];
      status: "succeeded";
      work?: z.infer<typeof WorkSchema>;
    }
  | { type: "error"; error: string; code?: string; retryAfter?: number; resetAt?: string; work?: z.infer<typeof WorkSchema> };

export async function POST(request: Request) {
  const user = requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = TranscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "原声音频缓存未就绪，请等待缓存完成后再转录。" }, { status: 400 });
  }

  return withUserRouteConcurrency(user.id, "douyin:transcribe", async () => {
    try {
      const { audioObjectKey, audioUrl, work } = parsed.data;
      if (!isManagedAsrAudioUrl({ objectKey: audioObjectKey, signedUrl: audioUrl })) {
        return NextResponse.json({ error: "原声音频缓存地址无效，请重新缓存后再转录。" }, { status: 400 });
      }

      const audioCache = readAsrAudioCache({
        objectKey: audioObjectKey,
        userId: user.id,
      });
      if (!audioCache) {
        return NextResponse.json({ error: "原声音频缓存已失效，请重新缓存后再转录。" }, { status: 400 });
      }

      const asrOptions = buildAsrOptions(parsed.data);
      return streamTranscribeOperation(
        ({ onDelta }) => transcribeDashScopeAsr(
          user.id,
          buildWorkCacheKey(work),
          {
            durationSeconds: audioCache.durationSeconds,
            objectKey: audioObjectKey,
            signedUrl: audioUrl,
          },
          asrOptions,
          {
            postprocess: {
              enabled: true,
              onDelta,
            },
            ...(parsed.data.clientJobId ? { clientJobId: parsed.data.clientJobId } : {}),
            ...(parsed.data.historyRecordId ? {
              historyContext: {
                historyRecordId: parsed.data.historyRecordId,
                work,
              },
            } : {}),
            signal: request.signal,
          },
        ),
        {
          fallbackAsrModel: asrOptions.model,
          work,
          userId: user.id,
        },
        request.signal,
      );
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "转录失败。",
        },
        { status: 500 },
      );
    }
  });
}

export async function GET(request: Request) {
  const user = requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const url = new URL(request.url);
  const parsed = ReadJobSchema.safeParse({
    jobId: url.searchParams.get("jobId"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "jobId 无效。" }, { status: 400 });
  }

  return streamTranscribeOperation(
    ({ onDelta }) => refreshDashScopeAsrJobWithOptions(user.id, parsed.data.jobId, {
      postprocess: {
        enabled: true,
        onDelta,
      },
      signal: request.signal,
    }),
    {
      userId: user.id,
    },
    request.signal,
  );
}

export async function DELETE(request: Request) {
  const user = requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const url = new URL(request.url);
  const parsed = ReadJobSchema.safeParse({
    jobId: url.searchParams.get("jobId"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "jobId 无效。" }, { status: 400 });
  }

  const canceled = await cancelDashScopeAsrJob(user.id, parsed.data.jobId);
  return NextResponse.json({ canceled });
}

function streamTranscribeOperation(
  run: (input: { onDelta: (delta: string) => void }) => Promise<DashScopeAsrJobResult | null>,
  options: {
    fallbackAsrModel?: DashScopeAsrModel;
    userId?: string;
    work?: z.infer<typeof WorkSchema>;
  },
  signal?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      const abort = () => close();
      signal?.addEventListener("abort", abort, { once: true });
      const send = (event: TranscribeStreamEvent) => {
        if (closed || signal?.aborted) {
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        let postprocessStarted = false;
        const result = await run({
          onDelta: (delta) => {
            if (!postprocessStarted) {
              postprocessStarted = true;
              send({ type: "postprocess_start", work: options.work });
            }
            send({ type: "delta", value: delta });
          },
        });
        if (signal?.aborted) {
          return;
        }

        if (!result) {
          send({ type: "error", error: "转录任务不存在或已过期。", work: options.work });
          return;
        }
        if (result.status === "running") {
          send({ type: "running", jobId: result.jobId, work: options.work });
          return;
        }
        if (!result.result.ok) {
          send({
            type: "error",
            code: result.result.code,
            error: result.result.detail,
            work: options.work,
          });
          return;
        }

        const resultItem = transcriptionResult(result.result, options.fallbackAsrModel);
        const historyContext = parseHistoryContext(result.historyContext);
        const historyRecord = resultItem.content && historyContext && options.userId
          ? saveTranscriptHistory({
              result: resultItem,
              userId: options.userId,
              work: historyContext,
            })
          : undefined;

        send({
          type: "done",
          historyRecord,
          results: [resultItem],
          status: "succeeded",
          work: options.work ?? historyContext,
        });
      } catch (error) {
        if (signal?.aborted) {
          return;
        }
        if (error instanceof DailyAsrQuotaExceededError) {
          const retryAfter = Math.max(1, Math.ceil((error.resetAt - Date.now()) / 1000));
          send({
            type: "error",
            error: error.message,
            resetAt: new Date(error.resetAt).toISOString(),
            retryAfter,
            work: options.work,
          });
          return;
        }

        send({
          type: "error",
          error: error instanceof Error ? error.message : "转录失败。",
          work: options.work,
        });
      } finally {
        signal?.removeEventListener("abort", abort);
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function parseHistoryContext(value: unknown): z.infer<typeof HistoryWorkSchema> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const context = value as { historyRecordId?: unknown; work?: unknown };
  const parsed = HistoryWorkSchema.safeParse({
    ...(context.work && typeof context.work === "object" ? context.work as Record<string, unknown> : {}),
    historyRecordId: context.historyRecordId,
  });
  return parsed.success ? parsed.data : undefined;
}

function saveTranscriptHistory(input: {
  result: ExtractionResult;
  userId: string;
  work: z.infer<typeof HistoryWorkSchema>;
}): TranscriptHistoryRecord | undefined {
  if (!input.result.content) {
    return undefined;
  }

  return upsertTranscriptHistoryRecord({
    authorName: input.work.authorName,
    durationSeconds: input.work.durationSeconds,
    finalUrl: input.work.finalUrl,
    id: input.work.historyRecordId,
    inputUrl: input.work.inputUrl,
    originalTitle: input.work.title,
    transcriptContent: input.result.content,
    transcriptSegments: input.result.transcriptSegments,
    userId: input.userId,
    workId: input.work.id,
    workKey: buildWorkCacheKey(input.work),
    workKind: input.work.kind,
  });
}

function buildAsrOptions(input: z.infer<typeof TranscribeSchema>) {
  const options: {
    diarizationEnabled?: boolean;
    enableItn?: boolean;
    model?: DashScopeAsrModel;
    specialWordFilter?: z.infer<typeof SpecialWordFilterSchema>;
    speakerCount?: number;
  } = {};
  const profile = input.model ?? E1_ASR_PROFILE;
  const model = getDashScopeAsrModelForProfile(profile);
  const isE1 = profile === E1_ASR_PROFILE;
  const isE2 = profile === E2_ASR_PROFILE;

  options.model = model;

  if (input.enableItn && isE1) {
    options.enableItn = true;
  }

  if (input.diarizationEnabled && isE2) {
    options.diarizationEnabled = true;
    if (input.speakerCount) {
      options.speakerCount = input.speakerCount;
    }
  }

  if (input.specialWordFilter && isE2) {
    options.specialWordFilter = input.specialWordFilter;
  }

  return options;
}

function buildWorkCacheKey(work: { id: string; kind: string }): string {
  return `${work.kind}:${work.id}`;
}

function transcriptionResult(result: ProviderResult, fallbackAsrModel?: DashScopeAsrModel): ExtractionResult {
  return result.ok
    ? {
        asrModel: result.asrModel ?? fallbackAsrModel,
        feature: TRANSCRIPT_FEATURE,
        label: getFeatureLabel(TRANSCRIPT_FEATURE),
        status: "success",
        source: "dashscope",
        content: result.content,
        emotions: result.emotions,
        transcriptSegments: result.transcriptSegments,
      }
    : {
        feature: TRANSCRIPT_FEATURE,
        label: getFeatureLabel(TRANSCRIPT_FEATURE),
        status: result.code,
        detail: result.detail,
      };
}
