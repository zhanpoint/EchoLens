import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InvitationError,
  listAccountServiceInvitations,
  redeemAccountServiceInvitation,
} from "@/lib/invitations/service";
import { execute, queryRow } from "@/lib/storage/postgres";
import { setupPostgresTestDb } from "@/test/postgres-test-utils";

setupPostgresTestDb();

describe("account service invitations", () => {
  it("initializes exactly 100 distinct plaintext codes idempotently", async () => {
    const first = await listAccountServiceInvitations();
    const second = await listAccountServiceInvitations();

    expect(first).toHaveLength(100);
    expect(new Set(first.map(({ code }) => code))).toHaveLength(100);
    expect(second.map(({ code }) => code)).toEqual(first.map(({ code }) => code));
    expect(first.every(({ code }) => /^ECHO-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/.test(code))).toBe(true);
  });

  it("migrates legacy invitations to production without losing redemption state", async () => {
    const code = "ECHO-AAAA-BBBB-CCCC";
    const userId = "legacy-user";
    await insertUser(userId, "legacy-reader");
    await execute(
      `INSERT INTO account_service_invitations (id, code, environment, redeemed_by, redeemed_at)
       VALUES ($1, $2, 'development', $3, CURRENT_TIMESTAMP)`,
      [randomUUID(), code, userId],
    );

    process.env.PROD = "true";
    try {
      const invitations = await listAccountServiceInvitations();
      const migrated = invitations.find((invitation) => invitation.code === code);

      expect(migrated).toMatchObject({
        code,
        environment: "production",
        redeemedBy: userId,
      });
      expect(migrated?.redeemedAt).not.toBeNull();
      await expect(queryRow<{ count: number }>(
        "SELECT count(*)::int AS count FROM account_service_invitations WHERE environment = 'development'",
      )).resolves.toMatchObject({ count: 0 });
    } finally {
      delete process.env.PROD;
    }
  });

  it("atomically grants permanent access and prevents a second user from redeeming the code", async () => {
    await insertUser("user-1", "reader-one");
    await insertUser("user-2", "reader-two");
    const [{ code }] = await listAccountServiceInvitations();

    await redeemAccountServiceInvitation("user-1", code);

    await expect(redeemAccountServiceInvitation("user-2", code)).rejects.toMatchObject({
      code: "INVITATION_USED",
    });
    await expect(readEntitlement("user-1")).resolves.toBe(true);
    await expect(readEntitlement("user-2")).resolves.toBe(false);

    const invitation = (await listAccountServiceInvitations()).find((item) => item.code === code);
    expect(invitation).toMatchObject({ redeemedBy: "user-1", redeemedByUsername: "reader-one" });
    expect(invitation?.redeemedAt).not.toBeNull();
  });

  it("keeps a redeemed code permanently used after the original user is deleted", async () => {
    await insertUser("user-1", "reader-one");
    await insertUser("user-2", "reader-two");
    const [{ code }] = await listAccountServiceInvitations();
    await redeemAccountServiceInvitation("user-1", code);

    await execute("DELETE FROM users WHERE id = $1", ["user-1"]);

    await expect(redeemAccountServiceInvitation("user-2", code)).rejects.toMatchObject({
      code: "INVITATION_USED",
    });
    expect((await listAccountServiceInvitations()).find((item) => item.code === code)).toMatchObject({
      redeemedAt: expect.anything(),
      redeemedBy: null,
    });
  });

  it("serializes concurrent attempts so only one user receives access", async () => {
    await insertUser("user-1", "reader-one");
    await insertUser("user-2", "reader-two");
    const [{ code }] = await listAccountServiceInvitations();

    const results = await Promise.allSettled([
      redeemAccountServiceInvitation("user-1", code),
      redeemAccountServiceInvitation("user-2", code),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const entitlements = await Promise.all([readEntitlement("user-1"), readEntitlement("user-2")]);
    expect(entitlements.filter(Boolean)).toHaveLength(1);
  });

  it("rejects another redemption after a user is entitled without consuming another code", async () => {
    await insertUser("user-1", "reader");
    const invitations = await listAccountServiceInvitations();

    await redeemAccountServiceInvitation("user-1", invitations[0].code);
    await expect(redeemAccountServiceInvitation("user-1", invitations[1].code)).rejects.toMatchObject({
      code: "ALREADY_REDEEMED",
    });

    const redeemed = (await listAccountServiceInvitations()).filter(({ redeemedBy }) => redeemedBy !== null);
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0].code).toBe(invitations[0].code);
  });

  it.each(["", "unknown", "ECHO-0000-0000-0000"])("rejects invalid or unknown code %j", async (code) => {
    await insertUser("user-1", "reader");

    await expect(redeemAccountServiceInvitation("user-1", code)).rejects.toBeInstanceOf(InvitationError);
    await expect(readEntitlement("user-1")).resolves.toBe(false);
  });
});

async function insertUser(id: string, username: string): Promise<void> {
  await execute(
    `INSERT INTO users (
       id, username, email, password_hash, terms_accepted_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, username, `${username}-${randomUUID()}@example.com`, "password-hash"],
  );
}

async function readEntitlement(userId: string): Promise<boolean> {
  const row = await queryRow<{ douyin_account_services_enabled: boolean }>(
    "SELECT douyin_account_services_enabled FROM users WHERE id = $1",
    [userId],
  );
  return row?.douyin_account_services_enabled === true;
}