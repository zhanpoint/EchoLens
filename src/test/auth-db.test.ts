import { describe, expect, it } from "vitest";
import { insertUser } from "@/lib/auth/db";
import { AuthError, loginUser } from "@/lib/auth/service";
import { hashPassword } from "@/lib/auth/password";
import { getEmailError, getPasswordError, getUsernameError } from "@/lib/auth/policy";
import { decryptSensitiveValue, encryptSensitiveValue } from "@/lib/sensitive-data";
import { execute, queryRow } from "@/lib/storage/postgres";
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

describe("auth postgres display views", () => {
  it("shows all auth table timestamps as Shanghai date strings", async () => {
    await insertUser({
      email: "reader@example.com",
      id: "user-1",
      passwordHash: "hash",
      termsAcceptedAt: Date.UTC(2026, 5, 25, 12, 34, 56),
      username: "reader",
    });
    await execute(
      "UPDATE users SET created_at = $1, updated_at = $2 WHERE id = $3",
      [Date.UTC(2026, 5, 24, 16, 0, 0), Date.UTC(2026, 5, 25, 15, 5, 9), "user-1"],
    );
    await execute(
      `INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        "token-hash",
        "user-1",
        Date.UTC(2026, 5, 26, 0, 0, 0),
        Date.UTC(2026, 5, 25, 1, 2, 3),
        Date.UTC(2026, 5, 25, 2, 3, 4),
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
        Date.UTC(2026, 5, 25, 3, 4, 5),
        Date.UTC(2026, 5, 25, 2, 4, 5),
        null,
      ],
    );

    expect(await queryRow("SELECT terms_accepted_at, created_at, updated_at FROM users_display")).toEqual({
      terms_accepted_at: "2026年06月25日 20:34",
      created_at: "2026年06月25日 00:00",
      updated_at: "2026年06月25日 23:05",
    });
    expect(await queryRow("SELECT expires_at, created_at, last_seen_at FROM sessions_display")).toEqual({
      expires_at: "2026年06月26日 08:00",
      created_at: "2026年06月25日 09:02",
      last_seen_at: "2026年06月25日 10:03",
    });
    expect(await queryRow("SELECT expires_at, sent_at, used_at FROM email_codes_display")).toEqual({
      expires_at: "2026年06月25日 11:04",
      sent_at: "2026年06月25日 10:04",
      used_at: null,
    });
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
      code: "EMAIL_NOT_FOUND",
      message: "该邮箱尚未注册，请先注册账号。",
      status: 401,
    } satisfies Partial<AuthError>);

    await expect(loginUser({
      acceptedLegal: true,
      identifier: "missing-user",
      password: "Aa123456!",
    })).rejects.toMatchObject({
      code: "USERNAME_NOT_FOUND",
      message: "该用户名不存在，请检查后重试。",
      status: 401,
    } satisfies Partial<AuthError>);

    await expect(loginUser({
      acceptedLegal: true,
      identifier: "reader@example.com",
      password: "Wrong123!",
    })).rejects.toMatchObject({
      code: "INVALID_PASSWORD",
      message: "密码错误，请重新输入，或使用“忘记密码”重置。",
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
