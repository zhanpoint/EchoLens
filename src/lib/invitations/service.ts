import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "@/lib/storage/postgres";

const INVITATION_POOL_SIZE = 100;
const INVITATION_LOCK_KEY = "account-service-invitations-v1";
const INVITATION_PATTERN = /^ECHO-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/;

export type AccountServiceInvitation = {
  code: string;
  createdAt: number;
  redeemedAt: number | null;
  redeemedBy: string | null;
  redeemedByUsername: string | null;
};

export type InvitationErrorCode = "ALREADY_REDEEMED" | "INVITATION_INVALID" | "INVITATION_USED" | "USER_NOT_FOUND";

export class InvitationError extends Error {
  constructor(message: string, readonly code: InvitationErrorCode) {
    super(message);
    this.name = "InvitationError";
  }
}

export async function listAccountServiceInvitations(): Promise<AccountServiceInvitation[]> {
  return withTransaction(async (client) => {
    await ensureInvitationPool(client);
    const result = await client.query<{
      code: string;
      created_at: number;
      redeemed_at: number | null;
      redeemed_by: string | null;
      redeemed_by_username: string | null;
    }>(
      `SELECT invitations.code, invitations.created_at, invitations.redeemed_at,
              invitations.redeemed_by, users.username AS redeemed_by_username
       FROM account_service_invitations invitations
       LEFT JOIN users ON users.id = invitations.redeemed_by
       ORDER BY invitations.created_at, invitations.code`,
    );
    return result.rows.map((row) => ({
      code: row.code,
      createdAt: row.created_at,
      redeemedAt: row.redeemed_at,
      redeemedBy: row.redeemed_by,
      redeemedByUsername: row.redeemed_by_username,
    }));
  });
}

export async function redeemAccountServiceInvitation(userId: string, input: string): Promise<void> {
  const code = normalizeInvitationCode(input);
  if (!INVITATION_PATTERN.test(code)) {
    throw new InvitationError("邀请码无效。", "INVITATION_INVALID");
  }

  await withTransaction(async (client) => {
    const userResult = await client.query<{ douyin_account_services_enabled: boolean }>(
      "SELECT douyin_account_services_enabled FROM users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new InvitationError("用户不存在。", "USER_NOT_FOUND");
    }
    if (user.douyin_account_services_enabled) {
      throw new InvitationError("当前账号已核销邀请码，不能重复核销。", "ALREADY_REDEEMED");
    }

    const claimedInvitation = await client.query<{ redeemed_by: string }>(
      `UPDATE account_service_invitations
       SET redeemed_by = $1, redeemed_at = CURRENT_TIMESTAMP
       WHERE code = $2 AND redeemed_at IS NULL
       RETURNING redeemed_by`,
      [userId, code],
    );
    if (claimedInvitation.rows.length === 0) {
      const invitationExists = await client.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM account_service_invitations WHERE code = $1) AS exists",
        [code],
      );
      if (invitationExists.rows[0]?.exists) {
        throw new InvitationError("邀请码已被使用。", "INVITATION_USED");
      }
      throw new InvitationError("邀请码无效。", "INVITATION_INVALID");
    }

    await client.query(
      "UPDATE users SET douyin_account_services_enabled = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [userId],
    );
  });
}

async function ensureInvitationPool(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [INVITATION_LOCK_KEY]);
  const result = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM account_service_invitations");
  let count = Number(result.rows[0]?.count ?? 0);
  while (count < INVITATION_POOL_SIZE) {
    const inserted = await client.query(
      `INSERT INTO account_service_invitations (id, code)
       VALUES ($1, $2)
       ON CONFLICT (code) DO NOTHING`,
      [randomUUID(), createInvitationCode()],
    );
    count += inserted.rowCount ?? 0;
  }
}

function createInvitationCode(): string {
  const value = randomBytes(9).toString("hex").toUpperCase();
  return `ECHO-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
}

function normalizeInvitationCode(value: string): string {
  return value.trim().toUpperCase();
}