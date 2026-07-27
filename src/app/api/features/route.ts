import { NextResponse } from "next/server";
import { readCurrentUserFromRequest } from "@/lib/auth/service";
import { canUseDouyinAccountServices } from "@/lib/douyin/account-services";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await readCurrentUserFromRequest(request);
  const douyinAccountServicesEnabled = canUseDouyinAccountServices(user);
  return NextResponse.json(
    {
      douyinAccountServicesEnabled,
      invitationRedeemed: user?.douyinAccountServicesEnabled === true,
    },
    { headers: { "cache-control": "no-store" } },
  );
}