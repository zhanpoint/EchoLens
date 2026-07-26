import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { PLATFORM_ASR_QUOTA_SECONDS } from "@/lib/dashscope/asr";
import { readDashScopeUserConfig } from "@/lib/dashscope/user-credential";
import { readPlatformAsrQuotaUsageSeconds } from "@/lib/transcript/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const [config, usedSeconds] = await Promise.all([
    readDashScopeUserConfig(user.id),
    readPlatformAsrQuotaUsageSeconds({ userId: user.id }),
  ]);
  const normalizedUsedSeconds = Math.max(0, usedSeconds);
  return NextResponse.json({
    configuredCustomApiKey: config.isCustomApiKey,
    exhausted: normalizedUsedSeconds >= PLATFORM_ASR_QUOTA_SECONDS,
    limitSeconds: PLATFORM_ASR_QUOTA_SECONDS,
    remainingSeconds: Math.max(0, PLATFORM_ASR_QUOTA_SECONDS - normalizedUsedSeconds),
    usedSeconds: normalizedUsedSeconds,
  });
}
