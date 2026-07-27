import { NextResponse } from "next/server";
import { z } from "zod";
import { errorJson, requireUser } from "@/app/api/auth/_shared";
import { enforceAuthRateLimits, readClientAddress } from "@/lib/auth/rate-limit";
import { InvitationError, redeemAccountServiceInvitation } from "@/lib/invitations/service";

export const runtime = "nodejs";

const RedeemInvitationSchema = z.object({
  code: z.string().trim().min(1).max(64),
});

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    if (user instanceof NextResponse) return user;

    const parsed = RedeemInvitationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ code: "INVITATION_INVALID", error: "请输入有效邀请码。" }, { status: 400 });
    }

    await enforceAuthRateLimits([
      { limit: 20, scope: "invitation-redeem-ip", subject: readClientAddress(request), windowSeconds: 60 * 60 },
      { limit: 10, scope: "invitation-redeem-user", subject: user.id, windowSeconds: 60 * 60 },
    ]);
    await redeemAccountServiceInvitation(user.id, parsed.data.code);
    return NextResponse.json({ douyinAccountServicesEnabled: true });
  } catch (error) {
    if (error instanceof InvitationError) {
      const status = error.code === "INVITATION_USED" || error.code === "ALREADY_REDEEMED"
        ? 409
        : error.code === "USER_NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ code: error.code, error: error.message }, { status });
    }
    return errorJson(error);
  }
}