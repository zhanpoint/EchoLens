import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export type PasswordValidation = {
  errors: string[];
  valid: boolean;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const key = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, salt, storedKey] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !storedKey) {
    return false;
  }

  const key = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  const stored = Buffer.from(storedKey, "base64url");
  return key.length === stored.length && timingSafeEqual(key, stored);
}

export function validatePassword(password: string): PasswordValidation {
  const errors: string[] = [];
  if (password.length < 8) {
    errors.push("密码至少需要 8 个字符。");
  }
  if (password.length > 128) {
    errors.push("密码不能超过 128 个字符。");
  }

  const typeCount = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;

  if (typeCount < 3) {
    errors.push("密码需要包含至少 3 种字符类型。");
  }

  return { errors, valid: errors.length === 0 };
}
