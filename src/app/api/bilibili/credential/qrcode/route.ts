import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { BilibiliCredentialError, generateBilibiliQRCode } from "@/lib/bilibili/account";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  try {
    return NextResponse.json(await generateBilibiliQRCode());
  } catch (error) {
    if (error instanceof BilibiliCredentialError) {
      return NextResponse.json({ code: error.code, error: error.message }, { status: 502 });
    }
    return NextResponse.json({ error: "Bilibili 二维码生成失败，请稍后重试。" }, { status: 502 });
  }
}