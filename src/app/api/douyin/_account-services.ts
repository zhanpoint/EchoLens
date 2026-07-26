import { NextResponse } from "next/server";
import {
  DOUYIN_ACCOUNT_SERVICES_DISABLED_CODE,
  DOUYIN_ACCOUNT_SERVICES_DISABLED_MESSAGE,
  isDouyinAccountServicesEnabled,
} from "@/lib/douyin/account-services";

export function rejectDisabledDouyinAccountServices(): NextResponse | null {
  return isDouyinAccountServicesEnabled()
    ? null
    : NextResponse.json(
        {
          code: DOUYIN_ACCOUNT_SERVICES_DISABLED_CODE,
          error: DOUYIN_ACCOUNT_SERVICES_DISABLED_MESSAGE,
        },
        { status: 503 },
      );
}