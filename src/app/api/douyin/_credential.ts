import { NextResponse } from "next/server";
import { markDouyinCredentialInvalid, readDouyinCredentialState } from "@/lib/douyin/account";
import { DouyinApiError, isDouyinCredentialError } from "@/lib/douyin/web-client";

export async function readValidDouyinCredential(userId: string): Promise<string | NextResponse> {
  const state = await readDouyinCredentialState(userId);
  if (state.status === "valid") {
    return state.cookie;
  }
  const issue = {
    invalid: {
      code: "CREDENTIAL_INVALID",
      error: "抖音账号访问凭证无效或已过期，请前往设置更新后重试。",
    },
    missing: {
      code: "CREDENTIAL_MISSING",
      error: "尚未设置抖音账号访问凭证，请先前往设置完成配置。",
    },
    unknown: {
      code: "CREDENTIAL_UNVERIFIED",
      error: "抖音账号访问凭证尚未验证，请前往设置重新保存并验证。",
    },
  }[state.status];
  return NextResponse.json(issue, { status: 409 });
}

export async function toDouyinApiErrorResponse(
  error: DouyinApiError,
  userId: string,
): Promise<NextResponse> {
  if (isDouyinCredentialError(error)) {
    await markDouyinCredentialInvalid(userId);
    return NextResponse.json({
      code: "CREDENTIAL_INVALID",
      error: "抖音账号访问凭证已失效，请前往设置更新后重试。",
    }, { status: 409 });
  }

  const status = error.code === "RATE_LIMITED"
    ? 429
    : error.code === "UPSTREAM_ERROR"
      ? 502
      : 503;
  const retryAfterSeconds = error.details?.retryAfterSeconds;
  return NextResponse.json({ code: error.code, error: error.message, retryAfterSeconds }, {
    status,
    headers: retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : undefined,
  });
}
