import { NextResponse } from "next/server";
import { readCurrentUserFromRequest } from "@/lib/auth/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await readCurrentUserFromRequest(request);
  return user
    ? NextResponse.json({ user })
    : NextResponse.json({ code: "UNAUTHENTICATED", error: "请先登录。" }, { status: 401 });
}
