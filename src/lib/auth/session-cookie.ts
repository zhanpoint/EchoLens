import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "el_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

type ParsedSessionCookie = {
  expiresAt: number;
  sessionId: string;
};

export function createSessionCookieValue(sessionId: string, expiresAt: number): string {
  const payload = `${sessionId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

export function readSessionCookieValue(value: string | undefined): ParsedSessionCookie | null {
  if (!value) {
    return null;
  }

  const parts = value.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [sessionId, expiresAtText, signature] = parts;
  if (!/^[A-Za-z0-9_-]{32,160}$/.test(sessionId) || !/^\d{10,16}$/.test(expiresAtText)) {
    return null;
  }

  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    return null;
  }

  const payload = `${sessionId}.${expiresAtText}`;
  if (!constantTimeEqual(signature, sign(payload))) {
    return null;
  }

  return { expiresAt, sessionId };
}

function sign(payload: string): string {
  return createHmac("sha256", readSessionSecret()).update(payload).digest("base64url");
}

function readSessionSecret(): string {
  const secret = process.env.AUTH_SESSION_SECRET ?? process.env.AUTH_SECRET;
  if (secret && secret.length >= 32) {
    return secret;
  }

  if (process.env.NODE_ENV !== "production") {
    return "echolens-local-development-session-secret";
  }

  throw new Error("AUTH_SESSION_SECRET must be at least 32 characters in production.");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
