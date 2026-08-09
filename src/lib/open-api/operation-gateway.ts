import type { ProviderResult } from "@/lib/ai/provider-result";
import {
  AsrQuotaExceededError,
  getDashScopeAsrModelForProfile,
  PLATFORM_ASR_QUOTA_SECONDS,
  transcribeDashScopeAsrOnce,
  type DashScopeAsrModelProfile,
} from "@/lib/dashscope/asr";
import { DEFAULT_DASHSCOPE_ASR_PROFILE, type EchoLensDashScopeModelIds } from "@/lib/dashscope/model-config";
import { readDashScopeUserConfig } from "@/lib/dashscope/user-credential";
import { resolveOpenTranscriptionMedia } from "@/lib/open-api/media-resource";
import {
  releaseOpenApiAsrQuota,
  reserveOpenApiAsrQuota,
} from "@/lib/transcript/db";

export async function createOpenTranscription(input: {
  input: string;
  model?: DashScopeAsrModelProfile;
  signal?: AbortSignal;
  userId: string;
}): Promise<Response> {
  const [config, media] = await Promise.all([
    readDashScopeUserConfig(input.userId),
    resolveOpenTranscriptionMedia({ input: input.input, userId: input.userId }),
  ]);
  const profile = input.model ?? DEFAULT_DASHSCOPE_ASR_PROFILE;
  let outcome = config.customApiKey
    ? await transcribeDashScopeAsrOnce(
        input.userId,
        media.audioUrl,
        { model: getDashScopeAsrModelForProfile(profile, config.customModels), profile },
        {
          apiKey: config.customApiKey,
          postprocess: { model: config.customModels.transcriptPostprocess },
          signal: input.signal,
          title: media.title,
        },
      )
    : undefined;

  if (!outcome || (!outcome.result.ok && outcome.fallbackEligible && config.platformApiKey)) {
    outcome = await transcribeWithPlatformQuota({
      apiKey: config.platformApiKey,
      durationSeconds: media.durationSeconds,
      models: config.platformModels,
      profile,
      signal: input.signal,
      signedUrl: media.audioUrl,
      title: media.title,
      userId: input.userId,
    });
  }

  if (!outcome) {
    return Response.json(
      { code: "ASR_NOT_CONFIGURED", error: "转录服务未配置。" },
      { status: 503 },
    );
  }
  if (!outcome.result.ok) return transcriptionFailure(outcome.result);

  return Response.json({
    media: media.resource,
    transcript: {
      text: outcome.result.content,
      ...(outcome.result.asrModel ? { model: outcome.result.asrModel } : {}),
      ...(outcome.result.emotions ? { emotions: outcome.result.emotions } : {}),
      ...(outcome.result.transcriptSegments ? { segments: outcome.result.transcriptSegments } : {}),
    },
  });
}

async function transcribeWithPlatformQuota(input: {
  apiKey?: string;
  durationSeconds: number;
  models: EchoLensDashScopeModelIds;
  profile: DashScopeAsrModelProfile;
  signal?: AbortSignal;
  signedUrl: string;
  title: string;
  userId: string;
}): Promise<{ fallbackEligible?: boolean; result: ProviderResult } | undefined> {
  if (!input.apiKey) return undefined;
  const reserved = await reserveOpenApiAsrQuota({
    durationSeconds: input.durationSeconds,
    limitSeconds: PLATFORM_ASR_QUOTA_SECONDS,
    userId: input.userId,
  });
  if (!reserved) throw new AsrQuotaExceededError();

  let consumed = false;
  try {
    const outcome = await transcribeDashScopeAsrOnce(
      input.userId,
      input.signedUrl,
      { model: getDashScopeAsrModelForProfile(input.profile, input.models), profile: input.profile },
      {
        apiKey: input.apiKey,
        postprocess: { model: input.models.transcriptPostprocess },
        signal: input.signal,
        title: input.title,
      },
    );
    consumed = outcome.result.ok;
    return outcome;
  } finally {
    if (!consumed) {
      await releaseOpenApiAsrQuota({
        durationSeconds: input.durationSeconds,
        userId: input.userId,
      });
    }
  }
}

function transcriptionFailure(result: Extract<ProviderResult, { ok: false }>): Response {
  return Response.json(
    { code: result.code, error: result.detail },
    { status: result.code === "no_speech" ? 422 : 502 },
  );
}