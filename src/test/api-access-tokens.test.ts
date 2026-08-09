import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: Array<Record<string, unknown>> = [];
const users = new Map<string, Record<string, unknown>>();

vi.mock("@/lib/storage/postgres", () => ({
  execute: vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql.startsWith("DELETE FROM api_access_tokens")) {
      const index = rows.findIndex((item) => item.user_id === values[0] && item.id === values[1]);
      if (index < 0) return 0;
      rows.splice(index, 1);
      return 1;
    }
    if (sql.includes("last_used_at")) {
      const row = rows.find((item) => item.token_hash === values[0]);
      if (row) {
        row.last_used_at = Number(values[1]);
        row.updated_at = Number(values[1]);
      }
      return row ? 1 : 0;
    }
    return 0;
  }),
  queryRow: vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql.startsWith("INSERT INTO api_access_tokens")) {
      const row = {
        id: values[0],
        user_id: values[1],
        name: values[2],
        token_hash: values[3],
        token_encrypted: JSON.parse(String(values[4])),
        token_prefix: values[5],
        expires_at: values[6] instanceof Date ? values[6].getTime() : null,
        last_used_at: null,
        created_at: values[7] instanceof Date ? values[7].getTime() : Number(values[7]),
        updated_at: values[7] instanceof Date ? values[7].getTime() : Number(values[7]),
      };
      rows.push(row);
      return toPublicRow(row);
    }
    if (sql.includes("JOIN users ON users.id = token.user_id")) {
      const token = rows.find((row) => row.token_hash === values[0]);
      if (!token) return undefined;
      const user = users.get(String(token.user_id));
      return user ? { ...user, token_hash: token.token_hash } : undefined;
    }
    if (sql.startsWith("UPDATE api_access_tokens")) {
      const row = rows.find((item) => item.user_id === values[0] && item.id === values[1]);
      if (!row) return undefined;
      return toPublicRow(row);
    }
    if (sql.includes("WHERE user_id = $1 AND id = $2")) {
      const row = rows.find((item) => item.user_id === values[0] && item.id === values[1]);
      return row ? toPublicRow(row) : undefined;
    }
    return undefined;
  }),
  queryRows: vi.fn(async () => rows.map(toPublicRow)),
  toPostgresTimestamp: (value: number) => new Date(value),
}));

import {
  createApiAccessToken,
  deleteApiAccessToken,
  listApiAccessTokens,
  readUserFromApiAccessToken,
  revealApiAccessToken,
} from "@/lib/api-access-tokens/service";

function toPublicRow(row: Record<string, unknown>) {
  return {
    created_at: row.created_at,
    expires_at: row.expires_at,
    id: row.id,
    last_used_at: row.last_used_at,
    name: row.name,
    token_encrypted: row.token_encrypted,
    token_prefix: row.token_prefix,
    updated_at: row.updated_at,
  };
}

describe("api access token service", () => {
  beforeEach(() => {
    process.env.DATA_ENCRYPTION_KEY = "test-data-encryption-key-with-at-least-32-characters";
    rows.length = 0;
    users.clear();
    users.set("user-1", {
      douyin_account_services_enabled: true,
      email: "agent@example.com",
      id: "user-1",
      role: "user",
      username: "agent",
    });
  });

  it("creates encrypted retrievable tokens and only lists metadata", async () => {
    const created = await createApiAccessToken({ name: "Agent", userId: "user-1" });

    expect(created.token).toMatch(/^el_/);
    expect(created.record.prefix).toBe(created.token.slice(0, 12));
    await expect(listApiAccessTokens("user-1")).resolves.toEqual([created.record]);
    await expect(revealApiAccessToken({ id: created.record.id, userId: "user-1" })).resolves.toBe(created.token);
  });

  it("deletes tokens and immediately rejects their bearer credentials", async () => {
    const created = await createApiAccessToken({ name: "Agent", userId: "user-1" });

    await expect(readUserFromApiAccessToken(created.token)).resolves.toMatchObject({ id: "user-1" });
    await deleteApiAccessToken({ id: created.record.id, userId: "user-1" });
    await expect(listApiAccessTokens("user-1")).resolves.toEqual([]);
    await expect(readUserFromApiAccessToken(created.token)).resolves.toBeNull();
  });
});