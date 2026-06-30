import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import type { ProviderResult } from "@/lib/ai/provider-result";
import {
  DailyAsrQuotaExceededError,
  getDashScopeAsrModelForProfile,
  readDashScopeAsrJob,
  refreshDashScopeAsrJob,
  transcribeDashScopeAsr,
  type DashScopeAsrModelProfile,
  type DashScopeAsrModel,
} from "@/lib/dashscope/asr";
import { isManagedAsrAudioUrl } from "@/lib/oss/asr-audio";
import { isProdRuntime } from "@/lib/runtime";
import { readAsrAudioCache } from "@/lib/transcript/db";
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

const TranscribeSchema = z.object({
  audioObjectKey: z.string().min(1).max(512),
  audioUrl: z.string().url().max(4096),
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
      if (work.kind !== "video") {
        return NextResponse.json({ error: "当前作品类型不支持转录文本提取。" }, { status: 400 });
      }
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
      const result = await transcribeDashScopeAsr(
        user.id,
        buildWorkCacheKey(work),
        {
          durationSeconds: audioCache.durationSeconds,
          objectKey: audioObjectKey,
          signedUrl: audioUrl,
        },
        asrOptions,
      );

      return buildTranscribeResponse(result, work, asrOptions.model);
    } catch (error) {
      if (error instanceof DailyAsrQuotaExceededError) {
        return asrQuotaExceededResponse(error);
      }

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

  const result = isProdRuntime()
    ? readDashScopeAsrJob(user.id, parsed.data.jobId)
    : await refreshDashScopeAsrJob(user.id, parsed.data.jobId);
  if (!result) {
    return NextResponse.json({ error: "转录任务不存在或已过期。" }, { status: 404 });
  }

  if (result.status === "running") {
    return NextResponse.json({ jobId: result.jobId, status: "running" }, { status: 202 });
  }

  return NextResponse.json({
    results: [transcriptionResult(result.result)],
    status: result.status,
  });
}

function buildTranscribeResponse(
  result: Awaited<ReturnType<typeof transcribeDashScopeAsr>>,
  work: z.infer<typeof WorkSchema>,
  model?: DashScopeAsrModel,
): NextResponse {
  if (result.status === "running") {
    return NextResponse.json(
      {
        jobId: result.jobId,
        status: "running",
        work,
      },
      { status: 202 },
    );
  }

  return NextResponse.json(
    result.result.ok
      ? {
          results: [transcriptionResult(result.result, model)],
          status: result.status,
          work,
        }
      : {
          error: result.result.detail,
          status: result.status,
          work,
        },
  );
}

function asrQuotaExceededResponse(error: DailyAsrQuotaExceededError): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((error.resetAt - Date.now()) / 1000));
  const response = NextResponse.json(
    {
      error: error.message,
      resetAt: new Date(error.resetAt).toISOString(),
      retryAfter,
    },
    { status: 429 },
  );
  response.headers.set("Retry-After", String(retryAfter));
  return response;
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
