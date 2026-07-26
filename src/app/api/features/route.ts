import { NextResponse } from "next/server";
import { isDouyinAccountServicesEnabled } from "@/lib/douyin/account-services";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { douyinAccountServicesEnabled: isDouyinAccountServicesEnabled() },
    { headers: { "cache-control": "no-store" } },
  );
}