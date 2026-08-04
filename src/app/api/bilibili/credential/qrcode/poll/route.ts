import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { BilibiliCredentialError, pollBilibiliQRCode } from "@/lib/bilibili/account";

export const runtime = "nodejs";

const InputSchema = z.object({
  qrcodeKey: z.string().trim().min(1).max(256),
});

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = InputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Bilibili 二维码参数无效。" }, { status: 400 });
  }

  try {
    return NextResponse.json(await pollBilibiliQRCode(user.id, parsed.data.qrcodeKey));
  } catch (error) {
    if (error instanceof BilibiliCredentialError) {
      const status = error.code === "UPSTREAM_ERROR" ? 502 : 400;
      return NextResponse.json({ code: error.code, error: error.message }, { status });
    }
    return NextResponse.json({ error: "Bilibili 二维码状态检测失败，请稍后重试。" }, { status: 502 });
  }
}