import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage/postgres", () => ({
  ensurePostgresSchema: vi.fn(),
}));

import { GET } from "@/app/api/health/route";
import { ensurePostgresSchema } from "@/lib/storage/postgres";

const ensurePostgresSchemaMock = vi.mocked(ensurePostgresSchema);

describe("health route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensurePostgresSchemaMock.mockResolvedValue();
  });

  it("reports healthy only after the database schema is ready", async () => {
    const response = await GET();

    expect(ensurePostgresSchemaMock).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("reports unavailable when database migration fails", async () => {
    ensurePostgresSchemaMock.mockRejectedValue(new Error("migration failed"));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });
});