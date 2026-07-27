import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { rejectDisabledDouyinAccountServices } from "../../_account-services";
import { readDouyinCredentialState } from "@/lib/douyin/account";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const disabled = rejectDisabledDouyinAccountServices(user);
  if (disabled) return disabled;
  const state = await readDouyinCredentialState(user.id);
  const message = {
    invalid: "抖音账号访问凭证无效或已过期，请前往设置更新后重试。",
    missing: "尚未设置抖音账号访问凭证，请先前往设置完成配置。",
    unknown: "抖音账号访问凭证尚未验证，请前往设置重新保存并验证。",
    valid: "抖音账号访问凭证状态正常。",
  }[state.status];
  return NextResponse.json({ checkedAt: state.checkedAt, message, status: state.status });
}
