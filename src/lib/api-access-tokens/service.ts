import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execute, queryRow, queryRows, toPostgresTimestamp } from "@/lib/storage/postgres";
import { decryptSensitiveValue, encryptSensitiveValue, isEncryptedValue, type EncryptedValue } from "@/lib/sensitive-data";
import type { AuthUser } from "@/lib/auth/service";

const TOKEN_PREFIX = "el_";
const TOKEN_SECRET_BYTES = 32;
const TOKEN_PREFIX_VISIBLE_CHARS = 12;

export type ApiAccessToken = {
  createdAt: number;
  expiresAt?: number;
  id: string;
  isExpired: boolean;
  lastUsedAt?: number;
  name: string;
  prefix: string;
  updatedAt: number;
};

export type CreatedApiAccessToken = {
  token: string;
  record: ApiAccessToken;
};

type ApiAccessTokenRow = {
  created_at: number;
  expires_at: number | null;
  id: string;
  last_used_at: number | null;
  name: string;
  token_encrypted?: EncryptedValue | null;
  token_prefix: string;
  updated_at: number;
};

type TokenUserRow = {
  douyin_account_services_enabled: boolean;
  email: string;
  id: string;
  role: "admin" | "user";
  username: string;
};

export class ApiAccessTokenError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "API_TOKEN_ERROR") {
    super(message);
  }
}

export async function listApiAccessTokens(userId: string): Promise<ApiAccessToken[]> {
  const rows = await queryRows<ApiAccessTokenRow>(
    `SELECT id, name, token_prefix, expires_at, last_used_at, created_at, updated_at
     FROM api_access_tokens
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(mapApiAccessToken);
}

export async function createApiAccessToken(input: {
  expiresAt?: number;
  name: string;
  userId: string;
}): Promise<CreatedApiAccessToken> {
  const name = normalizeTokenName(input.name);
  const expiresAt = normalizeExpiresAt(input.expiresAt);
  const token = createPlainToken();
  const id = randomUUID();
  const now = Date.now();
  const row = await queryRow<ApiAccessTokenRow>(
    `INSERT INTO api_access_tokens (
       id, user_id, name, token_hash, token_encrypted, token_prefix, expires_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $8)
     RETURNING id, name, token_prefix, expires_at, last_used_at, created_at, updated_at`,
    [
      id,
      input.userId,
      name,
      hashToken(token),
      JSON.stringify(encryptSensitiveValue(token, tokenEncryptionContext(input.userId, id))),
      token.slice(0, TOKEN_PREFIX_VISIBLE_CHARS),
      expiresAt ? toPostgresTimestamp(expiresAt) : null,
      toPostgresTimestamp(now),
    ],
  );
  if (!row) {
    throw new ApiAccessTokenError("API 访问令牌创建失败。", 500, "API_TOKEN_CREATE_FAILED");
  }
  return { record: mapApiAccessToken(row), token };
}

export async function updateApiAccessToken(input: {
  expiresAt?: number | null;
  id: string;
  name?: string;
  userId: string;
}): Promise<ApiAccessToken> {
  const current = await readOwnedTokenRow(input.userId, input.id);
  if (!current) throw new ApiAccessTokenError("API 访问令牌不存在。", 404, "API_TOKEN_NOT_FOUND");
  const name = input.name === undefined ? current.name : normalizeTokenName(input.name);
  const expiresAt = input.expiresAt === undefined ? current.expires_at : normalizeExpiresAt(input.expiresAt);
  const row = await queryRow<ApiAccessTokenRow>(
    `UPDATE api_access_tokens
     SET name = $3, expires_at = $4, updated_at = $5
     WHERE user_id = $1 AND id = $2
     RETURNING id, name, token_prefix, expires_at, last_used_at, created_at, updated_at`,
    [input.userId, input.id, name, expiresAt ? toPostgresTimestamp(expiresAt) : null, toPostgresTimestamp(Date.now())],
  );
  if (!row) throw new ApiAccessTokenError("API 访问令牌不存在。", 404, "API_TOKEN_NOT_FOUND");
  return mapApiAccessToken(row);
}

export async function resetApiAccessToken(input: {
  expiresAt?: number | null;
  id: string;
  userId: string;
}): Promise<CreatedApiAccessToken> {
  const current = await readOwnedTokenRow(input.userId, input.id);
  if (!current) throw new ApiAccessTokenError("API 访问令牌不存在。", 404, "API_TOKEN_NOT_FOUND");
  const token = createPlainToken();
  const expiresAt = input.expiresAt === undefined ? current.expires_at : normalizeExpiresAt(input.expiresAt);
  const row = await queryRow<ApiAccessTokenRow>(
    `UPDATE api_access_tokens
     SET token_hash = $3, token_encrypted = $4::jsonb, token_prefix = $5, expires_at = $6, updated_at = $7
     WHERE user_id = $1 AND id = $2
     RETURNING id, name, token_prefix, expires_at, last_used_at, created_at, updated_at`,
    [
      input.userId,
      input.id,
      hashToken(token),
      JSON.stringify(encryptSensitiveValue(token, tokenEncryptionContext(input.userId, input.id))),
      token.slice(0, TOKEN_PREFIX_VISIBLE_CHARS),
      expiresAt ? toPostgresTimestamp(expiresAt) : null,
      toPostgresTimestamp(Date.now()),
    ],
  );
  if (!row) throw new ApiAccessTokenError("API 访问令牌不存在。", 404, "API_TOKEN_NOT_FOUND");
  return { record: mapApiAccessToken(row), token };
}

export async function revealApiAccessToken(input: { id: string; userId: string }): Promise<string> {
  const row = await queryRow<Pick<ApiAccessTokenRow, "token_encrypted">>(
    `SELECT token_encrypted
     FROM api_access_tokens
     WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL
     LIMIT 1`,
    [input.userId, input.id],
  );
  if (!row) throw new ApiAccessTokenError("API 访问令牌不存在。", 404, "API_TOKEN_NOT_FOUND");
  let encrypted: unknown = row.token_encrypted;
  if (typeof encrypted === "string") {
    try {
      encrypted = JSON.parse(encrypted) as unknown;
    } catch {
      encrypted = undefined;
    }
  }
  if (!isEncryptedValue(encrypted)) {
    throw new ApiAccessTokenError("此令牌创建于明文查看功能启用之前，请先重置令牌。", 409, "API_TOKEN_PLAINTEXT_UNAVAILABLE");
  }
  try {
    return decryptSensitiveValue(encrypted, tokenEncryptionContext(input.userId, input.id));
  } catch {
    throw new ApiAccessTokenError("令牌密文无法使用当前加密密钥解密，请重置令牌。", 409, "API_TOKEN_DECRYPT_FAILED");
  }
}

export async function deleteApiAccessToken(input: { id: string; userId: string }): Promise<void> {
  const deleted = await execute(
    "DELETE FROM api_access_tokens WHERE user_id = $1 AND id = $2",
    [input.userId, input.id],
  );
  if (deleted === 0) throw new ApiAccessTokenError("API 访问令牌不存在。", 404, "API_TOKEN_NOT_FOUND");
}

export async function readUserFromApiAccessToken(token: string | undefined): Promise<AuthUser | null> {
  const plain = token?.trim();
  if (!plain?.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(plain);
  const row = await queryRow<TokenUserRow & { token_hash: string }>(
    `SELECT users.id, users.username, users.email, users.role, users.douyin_account_services_enabled,
            token.token_hash
     FROM api_access_tokens token
     JOIN users ON users.id = token.user_id
     WHERE token.token_hash = $1
       AND token.revoked_at IS NULL
       AND (token.expires_at IS NULL OR token.expires_at > CURRENT_TIMESTAMP)
     LIMIT 1`,
    [tokenHash],
  );
  if (!row || !safeEqual(row.token_hash, tokenHash)) return null;
  await execute(
    "UPDATE api_access_tokens SET last_used_at = $2, updated_at = $2 WHERE token_hash = $1",
    [tokenHash, toPostgresTimestamp(Date.now())],
  );
  return {
    douyinAccountServicesEnabled: row.douyin_account_services_enabled,
    email: row.email,
    id: row.id,
    role: row.role,
    username: row.username,
  };
}

function tokenEncryptionContext(userId: string, id: string): string {
  return `api-access-token:${userId}:${id}`;
}

function createPlainToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_SECRET_BYTES).toString("base64url")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeTokenName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > 80) {
    throw new ApiAccessTokenError("令牌名称需为 1-80 个字符。", 400, "API_TOKEN_INVALID_NAME");
  }
  return normalized;
}

function normalizeExpiresAt(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= Date.now()) {
    throw new ApiAccessTokenError("有效期必须晚于当前时间。", 400, "API_TOKEN_INVALID_EXPIRATION");
  }
  return value;
}

async function readOwnedTokenRow(userId: string, id: string): Promise<ApiAccessTokenRow | undefined> {
  return await queryRow<ApiAccessTokenRow>(
    `SELECT id, name, token_prefix, expires_at, last_used_at, created_at, updated_at
     FROM api_access_tokens
     WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL
     LIMIT 1`,
    [userId, id],
  );
}

function mapApiAccessToken(row: ApiAccessTokenRow): ApiAccessToken {
  const expiresAt = row.expires_at ?? undefined;
  return {
    createdAt: row.created_at,
    ...(expiresAt ? { expiresAt } : {}),
    id: row.id,
    isExpired: typeof expiresAt === "number" && expiresAt <= Date.now(),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    name: row.name,
    prefix: row.token_prefix,
    updatedAt: row.updated_at,
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}