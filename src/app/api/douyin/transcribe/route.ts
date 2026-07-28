import { NextResponse } from "next/server";
import { z } from "zod";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import type { ProviderResult } from "@/lib/ai/provider-result";
import {
  cancelDashScopeAsrJob,
  AsrQuotaExceededError,
  getDashScopeAsrModelForProfile,
  refreshDashScopeAsrJobWithOptions,
  transcribeDashScopeAsr,
  type DashScopeAsrJobResult,
  type DashScopeAsrModelProfile,
  type DashScopeAsrModel,
} from "@/lib/dashscope/asr";
import { DEFAULT_DASHSCOPE_ASR_PROFILE, type EchoLensDashScopeModelIds } from "@/lib/dashscope/model-config";
import { readDashScopeUserConfig } from "@/lib/dashscope/user-credential";
import { TranscribeWorkSchema } from "@/lib/douyin/transcribe-schema";
import { ensureHistoryAsset } from "@/lib/transcript/assets";
import {
  readTranscriptHistoryRecord,
  upsertTranscriptHistoryRecord,
  type StoredAsrHistoryContext,
  type TranscriptHistoryRecord,
} from "@/lib/transcript/db";
import {
  TRANSCRIPT_FEATURE,
  getFeatureLabel,
  type ExtractionResult,
} from "@/types/douyin";

export const runtime = "nodejs";

const E1_ASR_PROFILE: DashScopeAsrModelProfile = "e1";
const E2_ASR_PROFILE: DashScopeAsrModelProfile = "e2";
const CLIENT_JOB_ID_MAX_LENGTH = 128;
const FALLBACK_JOB_ID_SUFFIX = ":platform";

const SensitiveWordListSchema = z.object({
  word_list: z.array(z.string().trim().min(1)),
}).strict();

const SpecialWordFilterSchema = z.object({
  filter_with_empty: SensitiveWordListSchema.optional(),
  filter_with_signed: SensitiveWordListSchema.optional(),
  system_reserved_filter: z.boolean().optional(),
}).strict();

const WorkSchema = TranscribeWorkSchema;

const TranscribeSchema = z.object({
  clientJobId: z.string().min(1).max(CLIENT_JOB_ID_MAX_LENGTH).optional(),
  historyRecordId: z.string().min(1).max(128),
  diarizationEnabled: z.boolean().optional(),
  enableItn: z.boolean().optional(),
  model: z.enum([E1_ASR_PROFILE, E2_ASR_PROFILE]).optional(),
  specialWordFilter: SpecialWordFilterSchema.optional(),
  speakerCount: z.coerce.number().int().min(1).max(10).optional(),
}).strict();

const ReadJobSchema = z.object({
  jobId: z.string().min(1).max(CLIENT_JOB_ID_MAX_LENGTH),
}).strict();

type TranscribeStreamEvent =
  | { type: "running"; jobId: string; status: "running"; work?: z.infer<typeof WorkSchema> }
  | { type: "postprocess_start"; work?: z.infer<typeof WorkSchema> }
  | {
      type: "done";
      historyRecord?: TranscriptHistoryRecord;
      results: ExtractionResult[];
      status: "successed";
      work?: z.infer<typeof WorkSchema>;
    }
  | { type: "error"; error: string; code?: string; status: "canceled" | "failed"; work?: z.infer<typeof WorkSchema> };

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = TranscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    logServerError("douyin.transcribe.request", parsed.error);
    return NextResponse.json({ error: "转录失败，请稍后重试。" }, { status: 400 });
  }

  try {
    const history = await readTranscriptHistoryRecord({
      id: parsed.data.historyRecordId,
      userId: user.id,
    });
    if (!history) {
      return NextResponse.json({ error: "转录历史不存在。" }, { status: 404 });
    }
    const parsedWork = WorkSchema.safeParse({
      authorName: history.authorName,
      authorUrl: history.authorUrl,
      caption: history.caption,
      durationSeconds: history.durationSeconds,
      finalUrl: history.finalUrl,
      id: history.workId,
      inputUrl: history.inputUrl,
      kind: history.workKind,
    });
    if (!parsedWork.success) {
      return NextResponse.json({ error: "会话作品信息不完整，请重新检测作品。" }, { status: 409 });
    }
    const work = parsedWork.data;
    const audio = await ensureHistoryAsset({
      assetKind: "originalAudio",
      historyRecordId: history.id,
      userId: user.id,
    });
    if (!audio?.durationSeconds) {
      return NextResponse.json({ error: "原声音频准备失败，请稍后重试。" }, { status: 502 });
    }

    const dashScope = await readDashScopeUserConfig(user.id);
    const preferredModels = dashScope.customApiKey ? dashScope.customModels : dashScope.platformModels;
    const asrOptions = buildAsrOptions(parsed.data, preferredModels);
    return streamTranscribeOperation(
      async ({ onPostprocessStart }) => {
          const submit = (
            source: "custom" | "platform",
            models: EchoLensDashScopeModelIds,
            apiKey: string | undefined,
            clientJobId?: string,
          ) => transcribeDashScopeAsr(
            user.id,
            buildWorkCacheKey(work),
            {
              durationSeconds: audio.durationSeconds,
              objectKey: audio.objectKey,
              signedUrl: audio.url,
            },
            buildAsrOptions(parsed.data, models),
            {
              apiKey,
              credentialSource: source,
              ...(clientJobId ? { clientJobId } : {}),
              historyContext: {
                historyRecordId: history.id,
                work,
              },
              postprocess: {
                model: models.transcriptPostprocess,
                onStart: onPostprocessStart,
              },
              signal: request.signal,
            },
          );

          if (!dashScope.customApiKey) {
            return submit("platform", dashScope.platformModels, dashScope.platformApiKey, parsed.data.clientJobId);
          }

          const customResult = await submit(
            "custom",
            dashScope.customModels,
            dashScope.customApiKey,
            parsed.data.clientJobId,
          );
          return customResult.status === "failed" && customResult.fallbackEligible && dashScope.platformApiKey
            ? submit(
                "platform",
                dashScope.platformModels,
                dashScope.platformApiKey,
                parsed.data.clientJobId
                  ? `${parsed.data.clientJobId.slice(0, CLIENT_JOB_ID_MAX_LENGTH - FALLBACK_JOB_ID_SUFFIX.length)}${FALLBACK_JOB_ID_SUFFIX}`
                  : undefined,
              )
            : customResult;
      },
      {
        fallbackAsrModel: asrOptions.model,
        work,
        userId: user.id,
      },
      request.signal,
      (result) => cancelStartedAsrJob(user.id, result, parsed.data.clientJobId),
    );
  } catch (error) {
    logServerError("douyin.transcribe.submit", error);
    return NextResponse.json(
      { error: "转录失败，请稍后重试。" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const user = await requireUser(request);
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

  const dashScope = await readDashScopeUserConfig(user.id);
  return streamTranscribeOperation(
    ({ onPostprocessStart }) => refreshDashScopeAsrJobWithOptions(user.id, parsed.data.jobId, {
        apiKeys: {
          custom: dashScope.customApiKey,
          platform: dashScope.platformApiKey,
        },
        postprocess: {
          onStart: onPostprocessStart,
        },
        postprocessModels: {
          custom: dashScope.customModels.transcriptPostprocess,
          platform: dashScope.platformModels.transcriptPostprocess,
        },
        signal: request.signal,
      }),
    {
      userId: user.id,
    },
    request.signal,
    (result) => cancelStartedAsrJob(user.id, result),
  );
}

export async function DELETE(request: Request) {
  const user = await requireUser(request);
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

  const dashScope = await readDashScopeUserConfig(user.id);
  const canceled = await cancelDashScopeAsrJob(
    user.id,
    parsed.data.jobId,
    {
      custom: dashScope.customApiKey,
      platform: dashScope.platformApiKey,
    },
  );
  return NextResponse.json({ canceled });
}

function streamTranscribeOperation(
  run: (input: { onPostprocessStart: () => void }) => Promise<DashScopeAsrJobResult | null>,
  options: {
    fallbackAsrModel?: DashScopeAsrModel;
    userId?: string;
    work?: z.infer<typeof WorkSchema>;
  },
  signal?: AbortSignal,
  onAbort?: (result: DashScopeAsrJobResult | null) => Promise<void>,
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
          onPostprocessStart: () => {
            if (!postprocessStarted) {
              postprocessStarted = true;
              send({ type: "postprocess_start", work: options.work });
            }
          },
        });
        if (signal?.aborted) {
          await onAbort?.(result);
          return;
        }

        if (!result) {
          send({ type: "error", error: "转录任务不存在或已过期。", status: "failed", work: options.work });
          return;
        }
        if (result.status === "running") {
          send({ type: "running", jobId: result.jobId, status: "running", work: options.work });
          return;
        }
        if (!result.result.ok) {
          send({
            type: "error",
            code: result.result.code,
            error: result.result.detail,
            status: result.status === "canceled" ? "canceled" : "failed",
            work: options.work,
          });
          return;
        }

        const resultItem = transcriptionResult(result.result, options.fallbackAsrModel);
        const historyContext = result.historyContext;
        const historyRecord = resultItem.content && historyContext && options.userId
          ? await saveTranscriptHistory({
              result: resultItem,
              userId: options.userId,
              context: historyContext,
            })
          : undefined;

        send({
          type: "done",
          historyRecord,
          results: [resultItem],
          status: "successed",
          work: options.work ?? historyContext?.work,
        });
      } catch (error) {
        if (signal?.aborted) {
          return;
        }
        if (error instanceof AsrQuotaExceededError) {
          send({
            type: "error",
            error: error.message,
            status: "failed",
            work: options.work,
          });
          return;
        }

        logServerError("douyin.transcribe.stream", error);
        send({
          type: "error",
          error: "转录失败，请稍后重试。",
          status: "failed",
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

async function cancelStartedAsrJob(
  userId: string,
  result: DashScopeAsrJobResult | null,
  fallbackJobId?: string,
): Promise<void> {
  const jobId = result?.status === "running" ? result.jobId : fallbackJobId;
  if (jobId) {
    await cancelDashScopeAsrJob(userId, jobId).catch(() => undefined);
  }
}

async function saveTranscriptHistory(input: {
  context: StoredAsrHistoryContext;
  result: ExtractionResult;
  userId: string;
}): Promise<TranscriptHistoryRecord | undefined> {
  if (!input.result.content) {
    return undefined;
  }

  return await upsertTranscriptHistoryRecord({
    authorName: input.context.work.authorName,
    authorUrl: input.context.work.authorUrl,
    caption: input.context.work.caption,
    durationSeconds: input.context.work.durationSeconds,
    finalUrl: input.context.work.finalUrl,
    id: input.context.historyRecordId,
    inputUrl: input.context.work.inputUrl,
    transcriptContent: input.result.content,
    transcriptSegments: input.result.transcriptSegments,
    userId: input.userId,
    workId: input.context.work.id,
    workKey: buildWorkCacheKey(input.context.work),
    workKind: input.context.work.kind,
  });
}

function buildAsrOptions(input: z.infer<typeof TranscribeSchema>, models: EchoLensDashScopeModelIds) {
  const profile = input.model ?? DEFAULT_DASHSCOPE_ASR_PROFILE;
  const model = getDashScopeAsrModelForProfile(profile, models);
  const isE1 = profile === E1_ASR_PROFILE;
  const isE2 = profile === E2_ASR_PROFILE;

  const options: {
    diarizationEnabled?: boolean;
    enableItn?: boolean;
    model: DashScopeAsrModel;
    profile: DashScopeAsrModelProfile;
    specialWordFilter?: z.infer<typeof SpecialWordFilterSchema>;
    speakerCount?: number;
  } = { model, profile };

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

function transcriptionResult(
  result: Extract<ProviderResult, { ok: true }>,
  fallbackAsrModel?: DashScopeAsrModel,
): ExtractionResult {
  return {
    asrModel: result.asrModel ?? fallbackAsrModel,
    feature: TRANSCRIPT_FEATURE,
    label: getFeatureLabel(TRANSCRIPT_FEATURE),
    status: "success",
    source: "dashscope",
    content: result.content,
    emotions: result.emotions,
    transcriptSegments: result.transcriptSegments,
  };
}
