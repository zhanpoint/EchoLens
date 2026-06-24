import { createHash, randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import {
  cleanupExpiredAuthRows,
  markEmailCodeAttempt,
  markEmailCodeUsed,
  readActiveEmailCode,
  readRecentEmailCode,
  replaceEmailCode,
} from "@/lib/auth/db";

export const EMAIL_CODE_TTL_SECONDS = 5 * 60;
const EMAIL_CODE_RESEND_SECONDS = 60;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const LOGO_CID = "echolens-logo";

export type EmailCodePurpose = "reset" | "signup";

type AuthEmailKind = EmailCodePurpose | "login";
type AuthEmailCopy = {
  description: string;
  subject: string;
  title: string;
};

const AUTH_EMAIL_COPY: Record<AuthEmailKind, AuthEmailCopy> = {
  login: {
    description: "你的 EchoLens 账户刚刚完成登录。如果不是你本人操作，请尽快重置密码。",
    subject: "EchoLens - 登录提醒",
    title: "登录提醒",
  },
  reset: {
    description: "你正在重置 EchoLens 账户密码，请使用以下验证码完成验证。",
    subject: "EchoLens - 重置密码验证码",
    title: "重置密码验证码",
  },
  signup: {
    description: "感谢注册 EchoLens，请使用以下验证码完成账号创建。",
    subject: "EchoLens - 注册验证码",
    title: "欢迎注册 EchoLens",
  },
};

export async function sendEmailCode(email: string, purpose: EmailCodePurpose): Promise<void> {
  cleanupExpiredAuthRows();

  const recent = readRecentEmailCode(email, purpose);
  const waitSeconds = recent ? EMAIL_CODE_RESEND_SECONDS - Math.floor((Date.now() - recent.sent_at) / 1000) : 0;
  if (waitSeconds > 0) {
    throw new EmailRateLimitError(waitSeconds);
  }

  const code = generateEmailCode();
  replaceEmailCode({
    codeHash: hashEmailCode(email, purpose, code),
    email,
    expiresAt: Date.now() + EMAIL_CODE_TTL_SECONDS * 1000,
    id: randomUUID(),
    purpose,
  });

  await sendVerificationEmail(email, code, purpose);
}

export async function sendLoginNoticeEmail(email: string, username: string): Promise<void> {
  if (!hasSmtpConfig()) {
    return;
  }
  await sendAuthEmail({
    copy: AUTH_EMAIL_COPY.login,
    email,
    username,
  });
}

export function verifyEmailCode(email: string, purpose: EmailCodePurpose, code: string): boolean {
  cleanupExpiredAuthRows();
  const row = readActiveEmailCode(email, purpose);
  if (!row || row.expires_at <= Date.now() || row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    return false;
  }

  const ok = row.code_hash === hashEmailCode(email, purpose, code);
  if (!ok) {
    markEmailCodeAttempt(row.id, row.attempts + 1);
    return false;
  }

  markEmailCodeUsed(row.id);
  return true;
}

export class EmailRateLimitError extends Error {
  constructor(readonly waitSeconds: number) {
    super(`发送过于频繁，请 ${waitSeconds} 秒后再试。`);
  }
}

function generateEmailCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function hashEmailCode(email: string, purpose: EmailCodePurpose, code: string): string {
  return createHash("sha256")
    .update(`${email.toLowerCase()}|${purpose}|${code}|${readEmailCodeSecret()}`)
    .digest("hex");
}

function readEmailCodeSecret(): string {
  const secret = process.env.AUTH_EMAIL_CODE_SECRET ?? process.env.AUTH_SESSION_SECRET ?? process.env.AUTH_SECRET;
  if (secret && secret.length >= 32) {
    return secret;
  }
  if (process.env.NODE_ENV !== "production") {
    return "echolens-local-email-code-secret";
  }
  throw new Error("AUTH_EMAIL_CODE_SECRET must be at least 32 characters in production.");
}

async function sendVerificationEmail(email: string, code: string, purpose: EmailCodePurpose): Promise<void> {
  await sendAuthEmail({
    code,
    copy: AUTH_EMAIL_COPY[purpose],
    email,
  });
}

async function sendAuthEmail(input: {
  code?: string;
  copy: AuthEmailCopy;
  email: string;
  username?: string;
}): Promise<void> {
  const config = readSmtpConfig();
  const transporter = nodemailer.createTransport({
    auth: {
      pass: config.password,
      user: config.user,
    },
    host: config.host,
    port: config.port,
    requireTLS: config.useTls && !config.useSsl,
    secure: config.useSsl,
    tls: {
      servername: config.host,
    },
  });

  const content = buildAuthEmailContent(input);
  await transporter.sendMail({
    attachments: readLogoAttachment(),
    from: config.from,
    html: content.html,
    subject: input.copy.subject,
    text: content.text,
    to: input.email,
  });
}

export function hasSmtpConfig(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

function readSmtpConfig(): {
  from: string;
  host: string;
  password: string;
  port: number;
  useSsl: boolean;
  useTls: boolean;
  user: string;
} {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  if (!host || !user || !password) {
    throw new Error("SMTP 邮件配置缺失，请设置 SMTP_HOST、SMTP_USER 和 SMTP_PASSWORD。");
  }

  return {
    from: process.env.SMTP_FROM || user,
    host,
    password,
    port: Number(process.env.SMTP_PORT || 465),
    useSsl: readBooleanEnv("SMTP_USE_SSL", true),
    useTls: readBooleanEnv("SMTP_USE_TLS", false),
    user,
  };
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readLogoAttachment(): { cid: string; filename: string; path: string }[] {
  const logoPath = path.join(process.cwd(), "public", "echolens-logo.svg");
  if (!existsSync(logoPath)) {
    return [];
  }
  return [{ cid: LOGO_CID, filename: "echolens-logo.svg", path: logoPath }];
}

export function buildAuthEmailContent(input: {
  code?: string;
  copy: AuthEmailCopy;
  username?: string;
}): { html: string; text: string } {
  const safeTitle = escapeHtml(input.copy.title);
  const safeDescription = escapeHtml(input.copy.description);
  const safeUsername = input.username ? escapeHtml(input.username) : "";
  const codeBlock = input.code
    ? `<div style="text-align:center;margin:30px 0;">
                <div style="display:inline-block;padding:18px 34px;border-radius:12px;background:#111827;color:#20efd0;font-size:32px;font-weight:800;letter-spacing:8px;font-family:'Courier New',monospace;">
                  ${escapeHtml(input.code)}
                </div>
              </div>
              <p style="margin:24px 0 0;color:#64748b;font-size:14px;line-height:1.7;text-align:center;">此验证码 5 分钟内有效</p>`
    : `<div style="margin:28px 0;padding:20px 24px;border-radius:12px;background:#f1f5f9;color:#0f172a;font-size:15px;line-height:1.8;text-align:center;">
                ${safeUsername ? `登录账户：<strong>${safeUsername}</strong><br />` : ""}如非本人操作，请立即重置密码
              </div>`;

  return {
    html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td style="padding:40px 18px;">
        <table role="presentation" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(15,23,42,.12);">
          <tr>
            <td style="padding:30px;background:#111827;color:#ffffff;">
              <div style="text-align:center;">
                <img src="cid:${LOGO_CID}" width="64" height="57" alt="EchoLens" style="display:block;margin:0 auto 12px;border:0;outline:none;text-decoration:none;" />
                <div style="font-size:24px;font-weight:700;letter-spacing:-.02em;text-align:center;">EchoLens</div>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 30px 38px;">
              <h1 style="margin:0 0 14px;color:#111827;font-size:24px;line-height:1.3;text-align:center;">${safeTitle}</h1>
              <p style="margin:0 0 28px;color:#475569;font-size:15px;line-height:1.7;text-align:center;">${safeDescription}</p>
              ${codeBlock}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    text: `${input.copy.title}

${input.copy.description}

${input.code ? `验证码: ${input.code}` : input.username ? `登录账户: ${input.username}` : "登录提醒"}

${input.code ? "此验证码 5 分钟内有效，请勿泄露给他人。" : "如果不是你本人登录，请立即重置密码并检查邮箱安全。"}

如果这不是你的操作，请忽略此邮件。

EchoLens`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
