import { NextResponse } from "next/server";
import { assertDouyinAccountServicesEnabled } from "@/lib/douyin/account-services";
import { readDouyinCredentialState } from "@/lib/douyin/account";

export async function readValidDouyinCredential(userId: string): Promise<string | NextResponse> {
  assertDouyinAccountServicesEnabled();
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
