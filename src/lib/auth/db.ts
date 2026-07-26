import { execute, queryRow, toPostgresTimestamp, withTransaction } from "@/lib/storage/postgres";

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
  const row = await queryRow<UserRow>(
    `INSERT INTO users (id, username, email, password_hash, terms_accepted_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING id, username, email, password_hash, created_at`,
    [input.id, input.username, input.email, input.passwordHash, toPostgresTimestamp(input.termsAcceptedAt)],
  );
  if (!row) {
    throw new Error("用户创建失败。");
  }
  return row;
}

export async function updateUserPasswordAndDeleteSessions(userId: string, passwordHash: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [passwordHash, userId],
    );
    await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  });
}

export async function createSessionRow(input: {
  expiresAt: number;
  tokenHash: string;
  userId: string;
}): Promise<void> {
  await execute(
    `INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [input.tokenHash, input.userId, toPostgresTimestamp(input.expiresAt)],
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

  await execute("UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = $1", [tokenHash]);
  return row;
}

export async function cleanupExpiredAuthRows(): Promise<void> {
  await execute("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP");
  await execute("DELETE FROM email_codes WHERE expires_at <= CURRENT_TIMESTAMP OR used_at IS NOT NULL");
  await execute("DELETE FROM auth_rate_limits WHERE updated_at <= CURRENT_TIMESTAMP - INTERVAL '1 day'");
}

export async function replaceEmailCode(input: {
  codeHash: string;
  email: string;
  expiresAt: number;
  id: string;
  purpose: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE email_codes SET used_at = CURRENT_TIMESTAMP WHERE lower(email) = lower($1) AND purpose = $2 AND used_at IS NULL",
      [input.email, input.purpose],
    );
    await client.query(
      `INSERT INTO email_codes (id, email, purpose, code_hash, attempts, expires_at, sent_at, used_at)
       VALUES ($1, $2, $3, $4, 0, $5, CURRENT_TIMESTAMP, NULL)`,
      [input.id, input.email, input.purpose, input.codeHash, toPostgresTimestamp(input.expiresAt)],
    );
  });
}

export async function consumeEmailCode(input: {
  codeHash: string;
  email: string;
  maxAttempts: number;
  purpose: string;
}): Promise<boolean> {
  return await withTransaction(async (client) => {
    const result = await client.query<{ attempts: number; code_hash: string; expires_at: number; id: string }>(
      `SELECT id, code_hash, attempts, expires_at
       FROM email_codes
       WHERE lower(email) = lower($1) AND purpose = $2 AND used_at IS NULL
       ORDER BY sent_at DESC
       LIMIT 1
       FOR UPDATE`,
      [input.email, input.purpose],
    );
    const row = result.rows[0];
    if (!row || row.expires_at <= Date.now() || row.attempts >= input.maxAttempts) {
      return false;
    }

    if (row.code_hash !== input.codeHash) {
      await client.query(
        "UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1 AND used_at IS NULL",
        [row.id],
      );
      return false;
    }

    const consumed = await client.query(
      "UPDATE email_codes SET used_at = CURRENT_TIMESTAMP WHERE id = $1 AND used_at IS NULL RETURNING id",
      [row.id],
    );
    return consumed.rowCount === 1;
  });
}

export async function consumeAuthRateLimit(input: {
  limit: number;
  scope: string;
  subjectHash: string;
  windowSeconds: number;
}): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const now = Date.now();
  const row = await queryRow<{ attempts: number; window_started_at: number }>(
    `INSERT INTO auth_rate_limits (scope, subject_hash, attempts, window_started_at, updated_at)
     VALUES ($1, $2, 1, $3, $3)
     ON CONFLICT(scope, subject_hash) DO UPDATE SET
       attempts = CASE WHEN auth_rate_limits.window_started_at <= $4 THEN 1 ELSE auth_rate_limits.attempts + 1 END,
       window_started_at = CASE WHEN auth_rate_limits.window_started_at <= $4 THEN $3 ELSE auth_rate_limits.window_started_at END,
       updated_at = $3
     RETURNING attempts, window_started_at`,
    [
      input.scope,
      input.subjectHash,
      toPostgresTimestamp(now),
      toPostgresTimestamp(now - input.windowSeconds * 1000),
    ],
  );
  const attempts = Number(row?.attempts ?? input.limit + 1);
  const startedAt = Number(row?.window_started_at ?? now);
  return {
    allowed: attempts <= input.limit,
    retryAfterSeconds: Math.max(1, Math.ceil((startedAt + input.windowSeconds * 1000 - now) / 1000)),
  };
}

export async function clearAuthRateLimit(scope: string, subjectHash: string): Promise<void> {
  await execute("DELETE FROM auth_rate_limits WHERE scope = $1 AND subject_hash = $2", [scope, subjectHash]);
}
