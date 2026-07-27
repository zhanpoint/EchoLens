import { NextResponse } from "next/server";
import { readCurrentUserFromRequest } from "@/lib/auth/service";
import { canUseDouyinAccountServices } from "@/lib/douyin/account-services";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await readCurrentUserFromRequest(request);
  return NextResponse.json(
    { douyinAccountServicesEnabled: canUseDouyinAccountServices(user) },
    { headers: { "cache-control": "no-store" } },
  );
}