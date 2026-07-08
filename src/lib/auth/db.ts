import { execute, queryRow, withTransaction } from "@/lib/storage/postgres";

type UserRow = {
  created_at: number;
  email: string;
  id: string;
  password_hash: string;
  username: string;
};

type SessionRow = {
  email: string;
  expires_at: number;
  id: string;
  username: string;
};

type EmailCodeRow = {
  attempts: number;
  code_hash: string;
  expires_at: number;
  id: string;
};

export async function findUserByIdentifier(identifier: string): Promise<UserRow | undefined> {
  return await queryRow<UserRow>(
    `SELECT id, username, email, password_hash, created_at
     FROM users
     WHERE lower(username) = lower($1) OR lower(email) = lower($1)
     LIMIT 1`,
    [identifier],
  );
}

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  return await queryRow<UserRow>(
    `SELECT id, username, email, password_hash, created_at
     FROM users
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [email],
  );
}

export async function insertUser(input: {
  email: string;
  id: string;
  passwordHash: string;
  termsAcceptedAt: number;
  username: string;
}): Promise<UserRow> {
  const now = Date.now();
  const row = await queryRow<UserRow>(
    `INSERT INTO users (id, username, email, password_hash, terms_accepted_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING id, username, email, password_hash, created_at`,
    [input.id, input.username, input.email, input.passwordHash, input.termsAcceptedAt, now],
  );
  if (!row) {
    throw new Error("用户创建失败。");
  }
  return row;
}

export async function updateUserPassword(userId: string, passwordHash: string): Promise<void> {
  await execute(
    "UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3",
    [passwordHash, Date.now(), userId],
  );
}

export async function createSessionRow(input: {
  expiresAt: number;
  tokenHash: string;
  userId: string;
}): Promise<void> {
  const now = Date.now();
  await execute(
    `INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [input.tokenHash, input.userId, input.expiresAt, now],
  );
}

export async function deleteSessionRow(tokenHash: string): Promise<void> {
  await execute("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
}

export async function readSessionUser(tokenHash: string): Promise<SessionRow | undefined> {
  const row = await queryRow<SessionRow>(
    `SELECT users.id, users.username, users.email, sessions.expires_at
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1`,
    [tokenHash],
  );

  if (!row) {
    return undefined;
  }

  if (row.expires_at <= Date.now()) {
    await deleteSessionRow(tokenHash);
    return undefined;
  }

  await execute("UPDATE sessions SET last_seen_at = $1 WHERE token_hash = $2", [Date.now(), tokenHash]);
  return row;
}

export async function cleanupExpiredAuthRows(): Promise<void> {
  const now = Date.now();
  await execute("DELETE FROM sessions WHERE expires_at <= $1", [now]);
  await execute("DELETE FROM email_codes WHERE expires_at <= $1 OR used_at IS NOT NULL", [now]);
}

export async function readRecentEmailCode(email: string, purpose: string): Promise<{ sent_at: number } | undefined> {
  return await queryRow<{ sent_at: number }>(
    `SELECT sent_at
     FROM email_codes
     WHERE lower(email) = lower($1) AND purpose = $2 AND used_at IS NULL
     ORDER BY sent_at DESC
     LIMIT 1`,
    [email, purpose],
  );
}

export async function replaceEmailCode(input: {
  codeHash: string;
  email: string;
  expiresAt: number;
  id: string;
  purpose: string;
}): Promise<void> {
  const now = Date.now();
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE email_codes SET used_at = $1 WHERE lower(email) = lower($2) AND purpose = $3 AND used_at IS NULL",
      [now, input.email, input.purpose],
    );
    await client.query(
      `INSERT INTO email_codes (id, email, purpose, code_hash, attempts, expires_at, sent_at, used_at)
       VALUES ($1, $2, $3, $4, 0, $5, $6, NULL)`,
      [input.id, input.email, input.purpose, input.codeHash, input.expiresAt, now],
    );
  });
}

export async function readActiveEmailCode(email: string, purpose: string): Promise<EmailCodeRow | undefined> {
  return await queryRow<EmailCodeRow>(
    `SELECT id, code_hash, attempts, expires_at
     FROM email_codes
     WHERE lower(email) = lower($1) AND purpose = $2 AND used_at IS NULL
     ORDER BY sent_at DESC
     LIMIT 1`,
    [email, purpose],
  );
}

export async function markEmailCodeAttempt(id: string, attempts: number): Promise<void> {
  await execute("UPDATE email_codes SET attempts = $1 WHERE id = $2", [attempts, id]);
}

export async function markEmailCodeUsed(id: string): Promise<void> {
  await execute("UPDATE email_codes SET used_at = $1 WHERE id = $2", [Date.now(), id]);
}
