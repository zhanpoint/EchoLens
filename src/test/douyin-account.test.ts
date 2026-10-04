import { afterEach, describe, expect, it, vi } from "vitest";
import "./douyin-transport-test-utils";
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
      " sessionid=abc ; ttwid=token ; msToken=stored-token ",
    );
    expect(valid).toMatchObject({
      cookie: "sessionid=abc; ttwid=token; msToken=stored-token",
      status: "valid",
    });
    await expect(readDouyinCredentialState("credential-user")).resolves.toEqual(valid);

    // A rejected request says nothing about whether the submitted login expired.
    for (const status of [403, 429, 503]) {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response("temporary", { status }));
      await expect(validateAndStoreDouyinCredential("credential-user", "sessionid=candidate"))
        .rejects.toMatchObject({ code: status === 403 ? "ACCESS_BLOCKED" : status === 429 ? "RATE_LIMITED" : "UPSTREAM_ERROR" });
      await expect(readDouyinCredentialState("credential-user")).resolves.toEqual(valid);
    }

    await markDouyinCredentialInvalid("credential-user");
    await expect(readDouyinCredentialState("credential-user")).resolves.toMatchObject({
      cookie: "sessionid=abc; ttwid=token; msToken=stored-token",
      status: "invalid",
    });

    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({
      status_code: 0,
      user: {},
    })));
    await expect(
      validateAndStoreDouyinCredential("credential-user", "sessionid=expired; msToken=expired-token"),
    ).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
    await expect(readDouyinCredentialState("credential-user")).resolves.toMatchObject({
      cookie: "sessionid=expired; msToken=expired-token",
      status: "invalid",
    });
  });
});
