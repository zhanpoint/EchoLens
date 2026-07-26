import { NextResponse } from "next/server";
import { z } from "zod";
import { CodeSchema, EmailSchema, errorJson, PasswordSchema } from "@/app/api/auth/_shared";
import { registerUser, setSessionCookie } from "@/lib/auth/service";
import { clearAuthIdentityRateLimit, enforceAuthRateLimits, readClientAddress } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";

const RegisterSchema = z.object({
  acceptedLegal: z.boolean(),
  code: CodeSchema,
  confirmPassword: PasswordSchema,
  email: EmailSchema,
  password: PasswordSchema,
  username: z.string().trim().min(1).max(80),
});

export async function POST(request: Request) {
  try {
    const parsed = RegisterSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ code: "INVALID_INPUT", error: "请完整填写注册信息。" }, { status: 400 });
    }

    await enforceAuthRateLimits([
      { limit: 30, scope: "auth-register-ip", subject: readClientAddress(request), windowSeconds: 15 * 60 },
      { limit: 10, scope: "auth-register-email", subject: parsed.data.email, windowSeconds: 15 * 60 },
    ]);

    const user = await registerUser(parsed.data);
    await clearAuthIdentityRateLimit("auth-register-email", parsed.data.email);
    const response = NextResponse.json({ user });
    await setSessionCookie(response, user.id);
    return response;
  } catch (error) {
    return errorJson(error);
  }
}
