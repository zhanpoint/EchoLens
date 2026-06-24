import { NextResponse } from "next/server";
import { z } from "zod";
import { CodeSchema, EmailSchema, errorJson, PasswordSchema } from "@/app/api/auth/_shared";
import { resetPassword } from "@/lib/auth/service";

export const runtime = "nodejs";

const ResetPasswordSchema = z.object({
  code: CodeSchema,
  confirmPassword: PasswordSchema,
  email: EmailSchema,
  password: PasswordSchema,
});

export async function POST(request: Request) {
  try {
    const parsed = ResetPasswordSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ code: "INVALID_INPUT", error: "请完整填写重置密码信息。" }, { status: 400 });
    }

    await resetPassword(parsed.data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorJson(error);
  }
}
