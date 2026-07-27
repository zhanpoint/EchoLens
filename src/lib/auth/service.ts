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
  updateUserPasswordAndDeleteSessions,
} from "@/lib/auth/db";
import { verifyEmailCode } from "@/lib/auth/email";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getEmailError, getUsernameError, validatePassword } from "@/lib/auth/policy";
import {
  createSessionCookieValue,
  readSessionCookieValue,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth/session-cookie";

export type AuthUser = {
  douyinAccountServicesEnabled?: boolean;
  email: string;
  id: string;
  role?: "admin" | "user";
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

  if (await findUserByIdentifier(username)) {
    throw new AuthError("用户名已被使用。");
  }
  if (await findUserByEmail(email)) {
    throw new AuthError("邮箱已被注册。");
  }
  if (!(await verifyEmailCode(email, "signup", input.code))) {
    throw new AuthError("验证码无效或已过期。");
  }

  const user = await insertUser({
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
  const identifier = input.identifier.trim();
  const identifierError = identifier.includes("@") ? getEmailError(identifier) : getUsernameError(identifier);
  if (identifierError) {
    throw new AuthError(identifierError, 400, "INVALID_IDENTIFIER");
  }

  const user = await findUserByIdentifier(identifier);
  if (!user) {
    const isEmail = identifier.includes("@");
    throw new AuthError(
      isEmail ? "邮箱未注册。" : "用户名不存在。",
      404,
      isEmail ? "EMAIL_NOT_REGISTERED" : "USERNAME_NOT_FOUND",
    );
  }

  assertPassword(input.password, "INVALID_PASSWORD_FORMAT");
  if (!(await verifyPassword(input.password, user.password_hash))) {
    throw new AuthError("密码错误。", 401, "INVALID_CREDENTIALS");
  }
  return toAuthUser(user);
}

export async function loginUserWithEmailCode(input: {
  acceptedLegal: boolean;
  code: string;
  email: string;
}): Promise<AuthUser> {
  assertLegalAccepted(input.acceptedLegal);
  const email = normalizeEmail(input.email);
  const user = await findUserByEmail(email);
  if (!user || !(await verifyEmailCode(email, "login", input.code))) {
    throw new AuthError("验证码无效或已过期。", 401, "INVALID_CODE");
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

  const user = await findUserByEmail(email);
  if (!user) {
    throw new AuthError("验证码无效或已过期。");
  }
  if (!(await verifyEmailCode(email, "reset", input.code))) {
    throw new AuthError("验证码无效或已过期。");
  }

  await updateUserPasswordAndDeleteSessions(user.id, await hashPassword(input.password));
}

export function isAdminUser(user: AuthUser | null): boolean {
  return user?.role === "admin";
}

export async function emailExists(email: string): Promise<boolean> {
  return Boolean(await findUserByEmail(normalizeEmail(email)));
}

export async function setSessionCookie(response: NextResponse, userId: string): Promise<void> {
  const sessionId = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  await createSessionRow({
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

export async function readCurrentUserFromRequest(request: Request): Promise<AuthUser | null> {
  return await readCurrentUserFromCookieValue(readCookie(request.headers.get("cookie"), SESSION_COOKIE));
}

export async function deleteCurrentSessionFromRequest(request: Request): Promise<void> {
  const parsed = readSessionCookieValue(readCookie(request.headers.get("cookie"), SESSION_COOKIE));
  if (parsed) {
    await deleteSessionRow(hashSessionId(parsed.sessionId));
  }
}

export function assertPassword(password: string, code = "AUTH_ERROR"): void {
  const validation = validatePassword(password);
  if (!validation.valid) {
    throw new AuthError(validation.errors[0] ?? "密码强度不足。", 400, code);
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function readCurrentUserFromCookieValue(value: string | undefined): Promise<AuthUser | null> {
  const parsed = readSessionCookieValue(value);
  if (!parsed) {
    return null;
  }

  const row = await readSessionUser(hashSessionId(parsed.sessionId));
  return row ? toAuthUser(row) : null;
}

function normalizeUsername(username: string): string {
  const normalized = username.trim();
  const error = getUsernameError(normalized);
  if (error) {
    throw new AuthError(error);
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

function toAuthUser(row: {
  douyin_account_services_enabled: boolean;
  email: string;
  id: string;
  role: "admin" | "user";
  username: string;
}): AuthUser {
  return {
    douyinAccountServicesEnabled: row.douyin_account_services_enabled,
    email: row.email,
    id: row.id,
    role: row.role,
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
