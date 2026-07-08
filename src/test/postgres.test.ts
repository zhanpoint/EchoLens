import { describe, expect, it } from "vitest";
import { queryRow } from "@/lib/storage/postgres";
import { setupPostgresTestDb } from "@/test/postgres-test-utils";

setupPostgresTestDb();

describe("postgres storage", () => {
  it("creates the application schema before queries run", async () => {
    const row = await queryRow<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'`,
    );

    expect(row).toEqual({ table_name: "users" });
  });
});
