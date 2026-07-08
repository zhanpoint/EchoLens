import { describe, expect, it } from "vitest";
import { insertUser } from "@/lib/auth/db";
import { AuthError, loginUser } from "@/lib/auth/service";
import { hashPassword } from "@/lib/auth/password";
import { execute, queryRow } from "@/lib/storage/postgres";
import { setupPostgresTestDb } from "@/test/postgres-test-utils";

setupPostgresTestDb();

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
      code: "ACCOUNT_NOT_FOUND",
      message: "该邮箱尚未注册，请先注册账号。",
      status: 401,
    } satisfies Partial<AuthError>);

    await expect(loginUser({
      acceptedLegal: true,
      identifier: "reader@example.com",
      password: "wrong-password",
    })).rejects.toMatchObject({
      code: "INVALID_PASSWORD",
      message: "密码错误，请重新输入，或使用“忘记密码”重置。",
      status: 401,
    } satisfies Partial<AuthError>);
  });
});
