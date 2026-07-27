import { NextResponse } from "next/server";
import {
  canUseDouyinAccountServices,
  DOUYIN_ACCOUNT_SERVICES_DISABLED_CODE,
  DOUYIN_ACCOUNT_SERVICES_DISABLED_MESSAGE,
} from "@/lib/douyin/account-services";

type AccountServicesUser = {
  douyinAccountServicesEnabled?: boolean;
};

export function rejectDisabledDouyinAccountServices(user: AccountServicesUser): NextResponse | null {
  return canUseDouyinAccountServices(user)
    ? null
    : NextResponse.json(
        {
          code: DOUYIN_ACCOUNT_SERVICES_DISABLED_CODE,
          error: DOUYIN_ACCOUNT_SERVICES_DISABLED_MESSAGE,
        },
        { status: 503 },
      );
}