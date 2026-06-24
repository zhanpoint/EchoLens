import { NextResponse } from "next/server";
import { z } from "zod";
import { errorJson, PasswordSchema } from "@/app/api/auth/_shared";
import { sendLoginNoticeEmail } from "@/lib/auth/email";
import { loginUser, setSessionCookie } from "@/lib/auth/service";

export const runtime = "nodejs";

const LoginSchema = z.object({
  acceptedLegal: z.boolean(),
  identifier: z.string().trim().min(1).max(254),
  password: PasswordSchema,
});

export async function POST(request: Request) {
  try {
    const parsed = LoginSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ code: "INVALID_INPUT", error: "请输入账号和密码。" }, { status: 400 });
    }

    const user = await loginUser(parsed.data);
    const response = NextResponse.json({ user });
    await setSessionCookie(response, user.id);
    void sendLoginNoticeEmail(user.email, user.username).catch(() => undefined);
    return response;
  } catch (error) {
    return errorJson(error);
  }
}
