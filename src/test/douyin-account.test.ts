import { afterEach, describe, expect, it, vi } from "vitest";
import { insertUser } from "@/lib/auth/db";
import {
  markDouyinCredentialInvalid,
  readDouyinCredentialState,
  validateAndStoreDouyinCredential,
} from "@/lib/douyin/account";
import { setupPostgresTestDb } from "@/test/postgres-test-utils";

setupPostgresTestDb();

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DATA_ENCRYPTION_KEY;
});

describe("douyin credential state", () => {
  it("persists validation state and can invalidate the current credential", async () => {
    process.env.DATA_ENCRYPTION_KEY = "test-data-encryption-key-with-at-least-32-characters";
    await insertUser({
      email: "credential@example.com",
      id: "credential-user",
      passwordHash: "hash",
      termsAcceptedAt: Date.now(),
      username: "credential-user",
    });
    await expect(readDouyinCredentialState("credential-user")).resolves.toEqual({
      checkedAt: null,
      cookie: "",
      status: "missing",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      status_code: 0,
      user: { sec_uid: "self-sec" },
    })));
    const valid = await validateAndStoreDouyinCredential(
      "credential-user",
      " sessionid=abc ; ttwid=token ",
    );
    expect(valid).toMatchObject({
      cookie: "sessionid=abc; ttwid=token",
      status: "valid",
    });
    await expect(readDouyinCredentialState("credential-user")).resolves.toEqual(valid);

    await markDouyinCredentialInvalid("credential-user");
    await expect(readDouyinCredentialState("credential-user")).resolves.toMatchObject({
      cookie: "sessionid=abc; ttwid=token",
      status: "invalid",
    });

    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({
      status_code: 0,
      user: {},
    })));
    await expect(
      validateAndStoreDouyinCredential("credential-user", "sessionid=expired"),
    ).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
    await expect(readDouyinCredentialState("credential-user")).resolves.toMatchObject({
      cookie: "sessionid=expired",
      status: "invalid",
    });
  });
});
