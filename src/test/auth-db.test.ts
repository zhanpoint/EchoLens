import { describe, expect, it } from "vitest";
import {
  clearAuthRateLimit,
  consumeAuthRateLimit,
  consumeEmailCode,
  createSessionRow,
  insertUser,
  replaceEmailCode,
  updateUserPasswordAndDeleteSessions,
} from "@/lib/auth/db";
import { AuthError, loginUser } from "@/lib/auth/service";
import { hashPassword } from "@/lib/auth/password";
import { getEmailError, getPasswordError, getUsernameError } from "@/lib/auth/policy";
import { decryptSensitiveValue, encryptSensitiveValue } from "@/lib/sensitive-data";
import { execute, queryRow, toPostgresTimestamp } from "@/lib/storage/postgres";
import { setupPostgresTestDb } from "@/test/postgres-test-utils";

setupPostgresTestDb();

describe("sensitive data encryption", () => {
  it("encrypts values and binds them to their storage context", () => {
    const originalKey = process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_ENCRYPTION_KEY = "test-data-encryption-key-with-at-least-32-characters";
    try {
      const encrypted = encryptSensitiveValue("sessionid=secret", "user-1:douyin:cookie");
      expect(encrypted.ciphertext).not.toContain("sessionid");
      expect(decryptSensitiveValue(encrypted, "user-1:douyin:cookie")).toBe("sessionid=secret");
      expect(() => decryptSensitiveValue(encrypted, "user-2:douyin:cookie")).toThrow();
    } finally {
      process.env.DATA_ENCRYPTION_KEY = originalKey;
    }
  });
});

describe("auth credential policy", () => {
  it("uses registration rules before login", () => {
    expect(getUsernameError("ab")).toBe("用户名需为 3 到 24 位，可包含中文、字母、数字、下划线或短横线。");
    expect(getUsernameError("reader_01")).toBeUndefined();
    expect(getEmailError("reader@invalid")).toBe("请输入有效邮箱地址。");
    expect(getEmailError("reader@example.com")).toBeUndefined();
    expect(getPasswordError("123456")).toBe("密码至少需要 8 个字符。");
    expect(getPasswordError("abcdefgh")).toBe("密码需包含大写字母、小写字母、数字、特殊字符中的至少 3 种。");
    expect(getPasswordError("Aa123456!")).toBeUndefined();
  });
});

describe("auth postgres timestamps", () => {
  it("stores auth timestamps as native PostgreSQL date-time values", async () => {
    await insertUser({
      email: "reader@example.com",
      id: "user-1",
      passwordHash: "hash",
      termsAcceptedAt: Date.UTC(2026, 5, 25, 12, 34, 56),
      username: "reader",
    });
    await execute(
      "UPDATE users SET created_at = $1, updated_at = $2 WHERE id = $3",
      [
        toPostgresTimestamp(Date.UTC(2026, 5, 24, 16, 0, 0)),
        toPostgresTimestamp(Date.UTC(2026, 5, 25, 15, 5, 9)),
        "user-1",
      ],
    );
    await execute(
      `INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        "token-hash",
        "user-1",
        toPostgresTimestamp(Date.UTC(2026, 5, 26, 0, 0, 0)),
        toPostgresTimestamp(Date.UTC(2026, 5, 25, 1, 2, 3)),
        toPostgresTimestamp(Date.UTC(2026, 5, 25, 2, 3, 4)),
      ],
    );
    await execute(
      `INSERT INTO email_codes (id, email, purpose, code_hash, attempts, expires_at, sent_at, used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        "code-1",
        "reader@example.com",
        "signup",
        "code-hash",
        0,
        toPostgresTimestamp(Date.UTC(2026, 5, 25, 3, 4, 5)),
        toPostgresTimestamp(Date.UTC(2026, 5, 25, 2, 4, 5)),
        null,
      ],
    );

    const column = await queryRow<{ data_type: string }>(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'created_at'",
    );
    expect(["timestamptz", "timestamp with time zone"]).toContain(column?.data_type);
    expect(await queryRow("SELECT created_at FROM users WHERE id = $1", ["user-1"])).toEqual({
      created_at: toPostgresTimestamp(Date.UTC(2026, 5, 24, 16, 0, 0)),
    });
  });
});

describe("auth abuse controls", () => {
  it("blocks an email code after the atomic attempt limit", async () => {
    await replaceEmailCode({
      codeHash: "correct-hash",
      email: "reader@example.com",
      expiresAt: Date.now() + 60_000,
      id: "code-limit",
      purpose: "login",
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(consumeEmailCode({
        codeHash: "wrong-hash",
        email: "reader@example.com",
        maxAttempts: 5,
        purpose: "login",
      })).resolves.toBe(false);
    }
    await expect(consumeEmailCode({
      codeHash: "correct-hash",
      email: "reader@example.com",
      maxAttempts: 5,
      purpose: "login",
    })).resolves.toBe(false);
  });

  it("counts rate-limit attempts atomically and supports explicit reset", async () => {
    const input = { limit: 2, scope: "test-login", subjectHash: "subject", windowSeconds: 60 };
    await expect(consumeAuthRateLimit(input)).resolves.toMatchObject({ allowed: true });
    await expect(consumeAuthRateLimit(input)).resolves.toMatchObject({ allowed: true });
    await expect(consumeAuthRateLimit(input)).resolves.toMatchObject({ allowed: false });
    await clearAuthRateLimit(input.scope, input.subjectHash);
    await expect(consumeAuthRateLimit(input)).resolves.toMatchObject({ allowed: true });
  });

  it("revokes every session when a password is reset", async () => {
    await insertUser({
      email: "reset@example.com",
      id: "reset-user",
      passwordHash: "old-hash",
      termsAcceptedAt: Date.now(),
      username: "reset-user",
    });
    await createSessionRow({ expiresAt: Date.now() + 60_000, tokenHash: "session-token", userId: "reset-user" });
    await updateUserPasswordAndDeleteSessions("reset-user", "new-hash");
    await expect(queryRow("SELECT token_hash FROM sessions WHERE user_id = $1", ["reset-user"])).resolves.toBeUndefined();
  });
});

describe("auth password login errors", () => {
  it("distinguishes missing accounts from wrong passwords", async () => {
    await insertUser({
      email: "reader@example.com",
      id: "user-1",
      passwordHash: await hashPassword("Aa123456!"),
      termsAcceptedAt: Date.now(),
      username: "reader",
    });

    await expect(loginUser({
      acceptedLegal: true,
      identifier: "missing@example.com",
      password: "Aa123456!",
    })).rejects.toMatchObject({
      code: "EMAIL_NOT_REGISTERED",
      message: "邮箱未注册。",
      status: 404,
    } satisfies Partial<AuthError>);

    await expect(loginUser({
      acceptedLegal: true,
      identifier: "missing-user",
      password: "Aa123456!",
    })).rejects.toMatchObject({
      code: "USERNAME_NOT_FOUND",
      message: "用户名不存在。",
      status: 404,
    } satisfies Partial<AuthError>);

    await expect(loginUser({
      acceptedLegal: true,
      identifier: "reader@example.com",
      password: "Wrong123!",
    })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      message: "密码错误。",
      status: 401,
    } satisfies Partial<AuthError>);

    await expect(loginUser({
      acceptedLegal: true,
      identifier: "reader@example.com",
      password: "123456",
    })).rejects.toMatchObject({
      code: "INVALID_PASSWORD_FORMAT",
      message: "密码至少需要 8 个字符。",
      status: 400,
    } satisfies Partial<AuthError>);

    await expect(loginUser({
      acceptedLegal: true,
      identifier: "ab",
      password: "Aa123456!",
    })).rejects.toMatchObject({
      code: "INVALID_IDENTIFIER",
      message: "用户名需为 3 到 24 位，可包含中文、字母、数字、下划线或短横线。",
      status: 400,
    } satisfies Partial<AuthError>);
  });
});
