import { z } from "zod";
import { authJson, EmailSchema, errorJson } from "@/app/api/auth/_shared";
import { EmailRateLimitError, sendEmailCode } from "@/lib/auth/email";
import { AuthError, emailExists, normalizePurpose } from "@/lib/auth/service";

export const runtime = "nodejs";

const SendCodeSchema = z.object({
  email: EmailSchema,
  purpose: z.enum(["reset", "signup"]),
});

export async function POST(request: Request) {
  try {
    const parsed = SendCodeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AuthError("请输入有效邮箱。");
    }

    const email = parsed.data.email.toLowerCase();
    const purpose = normalizePurpose(parsed.data.purpose);
    if (purpose === "signup" && emailExists(email)) {
      throw new AuthError("邮箱已被注册。");
    }

    if (purpose === "reset" && !emailExists(email)) {
      return authJson({ message: "如果邮箱已注册，验证码将发送到该邮箱。", expiresIn: 300 });
    }

    await sendEmailCode(email, purpose);
    return authJson({ message: "验证码已发送。", expiresIn: 300 });
  } catch (error) {
    if (error instanceof EmailRateLimitError) {
      return authJson(
        { code: "EMAIL_RATE_LIMITED", error: error.message, retryAfter: error.waitSeconds },
        { status: 429 },
      );
    }
    return errorJson(error);
  }
}
