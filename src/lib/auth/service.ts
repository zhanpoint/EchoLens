import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import {
  createSessionRow,
  deleteSessionRow,
  findUserByEmail,
  findUserByIdentifier,
  insertUser,
  readSessionUser,
  updateUserPassword,
} from "@/lib/auth/db";
import { type EmailCodePurpose, verifyEmailCode } from "@/lib/auth/email";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/auth/password";
import {
  createSessionCookieValue,
  readSessionCookieValue,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth/session-cookie";

export type AuthUser = {
  email: string;
  id: string;
  username: string;
};

export class AuthError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "AUTH_ERROR") {
    super(message);
  }
}

export async function registerUser(input: {
  acceptedLegal: boolean;
  code: string;
  confirmPassword: string;
  email: string;
  password: string;
  username: string;
}): Promise<AuthUser> {
  assertLegalAccepted(input.acceptedLegal);
  const username = normalizeUsername(input.username);
  const email = normalizeEmail(input.email);
  assertPasswordConfirmation(input.password, input.confirmPassword);
  assertPassword(input.password);

  if (findUserByIdentifier(username)) {
    throw new AuthError("用户名已被使用。");
  }
  if (findUserByEmail(email)) {
    throw new AuthError("邮箱已被注册。");
  }
  if (!verifyEmailCode(email, "signup", input.code)) {
    throw new AuthError("验证码无效或已过期。");
  }

  const user = insertUser({
    email,
    id: randomUUID(),
    passwordHash: await hashPassword(input.password),
    termsAcceptedAt: Date.now(),
    username,
  });
  return toAuthUser(user);
}

export async function loginUser(input: {
  acceptedLegal: boolean;
  identifier: string;
  password: string;
}): Promise<AuthUser> {
  assertLegalAccepted(input.acceptedLegal);
  const user = findUserByIdentifier(input.identifier.trim());
  if (!user || !(await verifyPassword(input.password, user.password_hash))) {
    throw new AuthError("账号或密码错误。", 401, "INVALID_CREDENTIALS");
  }
  return toAuthUser(user);
}

export async function resetPassword(input: {
  code: string;
  confirmPassword: string;
  email: string;
  password: string;
}): Promise<void> {
  const email = normalizeEmail(input.email);
  assertPasswordConfirmation(input.password, input.confirmPassword);
  assertPassword(input.password);

  const user = findUserByEmail(email);
  if (!user) {
    throw new AuthError("验证码无效或已过期。");
  }
  if (!verifyEmailCode(email, "reset", input.code)) {
    throw new AuthError("验证码无效或已过期。");
  }

  updateUserPassword(user.id, await hashPassword(input.password));
}

export function emailExists(email: string): boolean {
  return Boolean(findUserByEmail(normalizeEmail(email)));
}

export async function setSessionCookie(response: NextResponse, userId: string): Promise<void> {
  const sessionId = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  createSessionRow({
    expiresAt,
    tokenHash: hashSessionId(sessionId),
    userId,
  });
  response.cookies.set(SESSION_COOKIE, createSessionCookieValue(sessionId, expiresAt), {
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

export async function readCurrentUserFromCookies(): Promise<AuthUser | null> {
  const store = await cookies();
  return readCurrentUserFromCookieValue(store.get(SESSION_COOKIE)?.value);
}

export function readCurrentUserFromRequest(request: Request): AuthUser | null {
  return readCurrentUserFromCookieValue(readCookie(request.headers.get("cookie"), SESSION_COOKIE));
}

export function deleteCurrentSessionFromRequest(request: Request): void {
  const parsed = readSessionCookieValue(readCookie(request.headers.get("cookie"), SESSION_COOKIE));
  if (parsed) {
    deleteSessionRow(hashSessionId(parsed.sessionId));
  }
}

export function assertPassword(password: string): void {
  const validation = validatePassword(password);
  if (!validation.valid) {
    throw new AuthError(validation.errors[0] ?? "密码强度不足。");
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizePurpose(value: string): EmailCodePurpose {
  if (value === "signup" || value === "reset") {
    return value;
  }
  throw new AuthError("验证码场景无效。");
}

function readCurrentUserFromCookieValue(value: string | undefined): AuthUser | null {
  const parsed = readSessionCookieValue(value);
  if (!parsed) {
    return null;
  }

  const row = readSessionUser(hashSessionId(parsed.sessionId));
  return row ? toAuthUser(row) : null;
}

function normalizeUsername(username: string): string {
  const normalized = username.trim();
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(normalized)) {
    throw new AuthError("用户名需为 3 到 24 位，可包含中文、字母、数字、下划线或短横线。");
  }
  return normalized;
}

function assertPasswordConfirmation(password: string, confirmPassword: string): void {
  if (password !== confirmPassword) {
    throw new AuthError("两次输入的密码不一致。");
  }
}

function assertLegalAccepted(acceptedLegal: boolean): void {
  if (!acceptedLegal) {
    throw new AuthError("请先阅读并同意用户协议和隐私政策。");
  }
}

function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function toAuthUser(row: { email: string; id: string; username: string }): AuthUser {
  return {
    email: row.email,
    id: row.id,
    username: row.username,
  };
}

function readCookie(cookieHeader: string | null, name: string): string | undefined {
  return cookieHeader
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
