import Database from "better-sqlite3";
import { getSqliteDb } from "@/lib/storage/sqlite";

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

type GlobalWithAuthDb = typeof globalThis & {
  __echolensAuthDbMigrated?: number;
};

const AUTH_SCHEMA_VERSION = 4;
const globalForAuthDb = globalThis as GlobalWithAuthDb;

export function getAuthDb(): Database.Database {
  const db = getSqliteDb();
  if (globalForAuthDb.__echolensAuthDbMigrated !== AUTH_SCHEMA_VERSION) {
    migrate(db);
    globalForAuthDb.__echolensAuthDbMigrated = AUTH_SCHEMA_VERSION;
  }
  return db;
}

export function findUserByIdentifier(identifier: string): UserRow | undefined {
  return getAuthDb()
    .prepare(
      `SELECT id, username, email, password_hash, created_at
       FROM users
       WHERE lower(username) = lower(?) OR lower(email) = lower(?)`,
    )
    .get(identifier, identifier) as UserRow | undefined;
}

export function findUserByEmail(email: string): UserRow | undefined {
  return getAuthDb()
    .prepare(
      `SELECT id, username, email, password_hash, created_at
       FROM users
       WHERE lower(email) = lower(?)`,
    )
    .get(email) as UserRow | undefined;
}

export function insertUser(input: {
  email: string;
  id: string;
  passwordHash: string;
  termsAcceptedAt: number;
  username: string;
}): UserRow {
  const now = Date.now();
  getAuthDb()
    .prepare(
      `INSERT INTO users (id, username, email, password_hash, terms_accepted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.username, input.email, input.passwordHash, input.termsAcceptedAt, now, now);

  return {
    created_at: now,
    email: input.email,
    id: input.id,
    password_hash: input.passwordHash,
    username: input.username,
  };
}

export function updateUserPassword(userId: string, passwordHash: string): void {
  getAuthDb()
    .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(passwordHash, Date.now(), userId);
}

export function createSessionRow(input: { expiresAt: number; tokenHash: string; userId: string }): void {
  const now = Date.now();
  getAuthDb()
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.tokenHash, input.userId, input.expiresAt, now, now);
}

export function deleteSessionRow(tokenHash: string): void {
  getAuthDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function readSessionUser(tokenHash: string): SessionRow | undefined {
  const row = getAuthDb()
    .prepare(
      `SELECT users.id, users.username, users.email, sessions.expires_at
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ?`,
    )
    .get(tokenHash) as SessionRow | undefined;

  if (!row) {
    return undefined;
  }

  if (row.expires_at <= Date.now()) {
    deleteSessionRow(tokenHash);
    return undefined;
  }

  getAuthDb().prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(Date.now(), tokenHash);
  return row;
}

export function cleanupExpiredAuthRows(): void {
  const now = Date.now();
  const db = getAuthDb();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM email_codes WHERE expires_at <= ? OR used_at IS NOT NULL").run(now);
}

export function readRecentEmailCode(email: string, purpose: string): { sent_at: number } | undefined {
  return getAuthDb()
    .prepare(
      `SELECT sent_at
       FROM email_codes
       WHERE lower(email) = lower(?) AND purpose = ? AND used_at IS NULL
       ORDER BY sent_at DESC
       LIMIT 1`,
    )
    .get(email, purpose) as { sent_at: number } | undefined;
}

export function replaceEmailCode(input: {
  codeHash: string;
  email: string;
  expiresAt: number;
  id: string;
  purpose: string;
}): void {
  const db = getAuthDb();
  const now = Date.now();
  db.transaction(() => {
    db.prepare("UPDATE email_codes SET used_at = ? WHERE lower(email) = lower(?) AND purpose = ? AND used_at IS NULL")
      .run(now, input.email, input.purpose);
    db.prepare(
      `INSERT INTO email_codes (id, email, purpose, code_hash, attempts, expires_at, sent_at, used_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, NULL)`,
    ).run(input.id, input.email, input.purpose, input.codeHash, input.expiresAt, now);
  })();
}

export function readActiveEmailCode(email: string, purpose: string): EmailCodeRow | undefined {
  return getAuthDb()
    .prepare(
      `SELECT id, code_hash, attempts, expires_at
       FROM email_codes
       WHERE lower(email) = lower(?) AND purpose = ? AND used_at IS NULL
       ORDER BY sent_at DESC
       LIMIT 1`,
    )
    .get(email, purpose) as EmailCodeRow | undefined;
}

export function markEmailCodeAttempt(id: string, attempts: number): void {
  getAuthDb().prepare("UPDATE email_codes SET attempts = ? WHERE id = ?").run(attempts, id);
}

export function markEmailCodeUsed(id: string): void {
  getAuthDb().prepare("UPDATE email_codes SET used_at = ? WHERE id = ?").run(Date.now(), id);
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      terms_accepted_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS email_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      sent_at INTEGER NOT NULL,
      used_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS email_codes_lookup_idx ON email_codes(email, purpose, used_at, sent_at);

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, category)
    );

    CREATE INDEX IF NOT EXISTS user_settings_user_id_idx ON user_settings(user_id);

    DROP VIEW IF EXISTS users_display;
    DROP VIEW IF EXISTS sessions_display;
    DROP VIEW IF EXISTS email_codes_display;
    DROP VIEW IF EXISTS auth_users_display;
    DROP VIEW IF EXISTS auth_sessions_display;
    DROP VIEW IF EXISTS auth_email_codes_display;

    CREATE VIEW users_display AS
    SELECT
      id,
      username,
      email,
      strftime('%Y年%m月%d日 %H:%M:%S', terms_accepted_at / 1000, 'unixepoch', '+8 hours') AS terms_accepted_at,
      strftime('%Y年%m月%d日 %H:%M:%S', created_at / 1000, 'unixepoch', '+8 hours') AS created_at,
      strftime('%Y年%m月%d日 %H:%M:%S', updated_at / 1000, 'unixepoch', '+8 hours') AS updated_at
    FROM users;

    CREATE VIEW sessions_display AS
    SELECT
      token_hash,
      user_id,
      strftime('%Y年%m月%d日 %H:%M:%S', expires_at / 1000, 'unixepoch', '+8 hours') AS expires_at,
      strftime('%Y年%m月%d日 %H:%M:%S', created_at / 1000, 'unixepoch', '+8 hours') AS created_at,
      strftime('%Y年%m月%d日 %H:%M:%S', last_seen_at / 1000, 'unixepoch', '+8 hours') AS last_seen_at
    FROM sessions;

    CREATE VIEW email_codes_display AS
    SELECT
      id,
      email,
      purpose,
      code_hash,
      attempts,
      strftime('%Y年%m月%d日 %H:%M:%S', expires_at / 1000, 'unixepoch', '+8 hours') AS expires_at,
      strftime('%Y年%m月%d日 %H:%M:%S', sent_at / 1000, 'unixepoch', '+8 hours') AS sent_at,
      strftime('%Y年%m月%d日 %H:%M:%S', used_at / 1000, 'unixepoch', '+8 hours') AS used_at
    FROM email_codes;
  `);
}
