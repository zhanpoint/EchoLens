import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { isAdminUser } from "@/lib/auth/service";
import { listAccountServiceInvitations } from "@/lib/invitations/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;
  if (!isAdminUser(user)) {
    return NextResponse.json({ code: "FORBIDDEN", error: "无权访问。" }, { status: 403 });
  }

  const invitations = await listAccountServiceInvitations();
  return NextResponse.json(
    { invitations },
    { headers: { "cache-control": "private, no-store" } },
  );
}