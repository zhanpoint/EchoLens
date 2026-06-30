import { NextResponse } from "next/server";
import { z } from "zod";
import { CodeSchema, EmailSchema, errorJson, PasswordSchema } from "@/app/api/auth/_shared";
import { sendLoginNoticeEmail } from "@/lib/auth/email";
import { loginUser, loginUserWithEmailCode, setSessionCookie } from "@/lib/auth/service";

export const runtime = "nodejs";

const PasswordLoginSchema = z.object({
  acceptedLegal: z.boolean(),
  identifier: z.string().trim().min(1).max(254),
  method: z.literal("password").optional(),
  password: PasswordSchema,
});

const CodeLoginSchema = z.object({
  acceptedLegal: z.boolean(),
  code: CodeSchema,
  email: EmailSchema,
  method: z.literal("code"),
});

const LoginSchema = z.union([PasswordLoginSchema, CodeLoginSchema]);

export async function POST(request: Request) {
  try {
    const parsed = LoginSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ code: "INVALID_INPUT", error: "请输入账号和密码。" }, { status: 400 });
    }

    const user = parsed.data.method === "code"
      ? await loginUserWithEmailCode({
          acceptedLegal: parsed.data.acceptedLegal,
          code: parsed.data.code,
          email: parsed.data.email,
        })
      : await loginUser({
          acceptedLegal: parsed.data.acceptedLegal,
          identifier: parsed.data.identifier,
          password: parsed.data.password,
        });
    const response = NextResponse.json({ user });
    await setSessionCookie(response, user.id);
    void sendLoginNoticeEmail(user.email, user.username).catch(() => undefined);
    return response;
  } catch (error) {
    return errorJson(error);
  }
}
