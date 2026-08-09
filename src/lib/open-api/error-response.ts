import { AsrQuotaExceededError } from "@/lib/dashscope/asr";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";
import {
  BilibiliApiError,
  DouyinResolveError,
  MediaRedirectError,
} from "@/lib/open-api/media-resource";
import { OpenApiPlatformCooldownError } from "@/lib/open-api/platform-request-policy";

export function openApiErrorResponse(error: unknown, fallbackMessage: string): Response {
  if (error instanceof AsrQuotaExceededError) {
    return Response.json(
      { code: "ASR_QUOTA_EXCEEDED", error: error.message },
      { status: 429 },
    );
  }
  if (error instanceof OpenApiPlatformCooldownError) {
    return Response.json(
      {
        code: "UPSTREAM_RATE_LIMITED",
        error: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
      },
      {
        headers: { "retry-after": String(error.retryAfterSeconds) },
        status: 429,
      },
    );
  }
  if (error instanceof NetworkRetryExhaustedError) {
    return Response.json(
      { code: NETWORK_RETRY_ERROR_CODE, error: NETWORK_RETRY_ERROR_MESSAGE },
      { status: 503 },
    );
  }
  if (error instanceof MediaRedirectError) {
    return Response.json(
      { code: error.code, error: error.message },
      { status: error.code === "network_error" ? 503 : 400 },
    );
  }
  if (error instanceof DouyinResolveError || error instanceof BilibiliApiError) {
    return Response.json(
      { code: "invalid_media_link", error: "该抖音或 Bilibili 视频链接已失效或无法访问，请确认后重新输入。" },
      { status: 400 },
    );
  }
  return Response.json({ error: fallbackMessage }, { status: 502 });
}