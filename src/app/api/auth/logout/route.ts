import { NextResponse } from "next/server";
import { clearSessionCookie, deleteCurrentSessionFromRequest } from "@/lib/auth/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  deleteCurrentSessionFromRequest(request);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
