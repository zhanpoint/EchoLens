import { afterEach, describe, expect, it, vi } from "vitest";
import { insertUser } from "@/lib/auth/db";
import { readUserSetting, upsertUserSetting } from "@/lib/user-settings";
import {
  generateBilibiliQRCode,
  pollBilibiliQRCode,
  validateAndStoreBilibiliCredential,
} from "@/lib/bilibili/account";
import { setupPostgresTestDb } from "@/test/postgres-test-utils";

setupPostgresTestDb();

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DATA_ENCRYPTION_KEY;
});

describe("bilibili credential state", () => {
  it("preserves the saved credential when the upstream probe is unavailable", async () => {
    process.env.DATA_ENCRYPTION_KEY = "test-data-encryption-key-with-at-least-32-characters";
    await insertUser({
      email: "retained@example.com", id: "retained-user", passwordHash: "hash",
      termsAcceptedAt: Date.now(), username: "retained-user",
    });
    const saved = { cookie: "SESSDATA=previous", credentialStatus: "valid", credentialCheckedAt: 123 };
    await upsertUserSetting("retained-user", "bilibili", saved);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { isLogin: true, mid: 42 } }))
      .mockResolvedValueOnce(new Response("blocked", { status: 412 }));

    await expect(validateAndStoreBilibiliCredential("retained-user", "SESSDATA=new"))
      .rejects.toMatchObject({ code: "UPSTREAM_ERROR", message: expect.stringContaining("HTTP 412") });
    await expect(readUserSetting("retained-user", "bilibili")).resolves.toEqual(saved);
  });

  it.each([
    { name: "expired login", nav: { code: -101, message: "未登录" }, probe: undefined, code: "LOGIN_REQUIRED", requests: 1 },
    { name: "missing account identity", nav: { code: 0, data: { isLogin: true } }, probe: undefined, code: "UPSTREAM_ERROR", requests: 1 },
    { name: "rejected collection access", nav: { code: 0, data: { isLogin: true, mid: 42 } }, probe: new Response("blocked", { status: 412 }), code: "UPSTREAM_ERROR", requests: 2 },
    { name: "expired collection session", nav: { code: 0, data: { isLogin: true, mid: 42 } }, probe: jsonResponse({ code: -101 }), code: "LOGIN_REQUIRED", requests: 2 },
    { name: "malformed collection payload", nav: { code: 0, data: { isLogin: true, mid: 42 } }, probe: jsonResponse({ code: 0, data: {} }), code: "UPSTREAM_ERROR", requests: 2 },
  ])("does not save a valid credential after $name", async ({ nav, probe, code, requests }) => {
    process.env.DATA_ENCRYPTION_KEY = "test-data-encryption-key-with-at-least-32-characters";
    await insertUser({
      email: "probe@example.com", id: "probe-user", passwordHash: "hash",
      termsAcceptedAt: Date.now(), username: "probe-user",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(nav));
    if (probe) fetchMock.mockResolvedValueOnce(probe);

    await expect(validateAndStoreBilibiliCredential("probe-user", "SESSDATA=abc"))
      .rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    const stored = await readUserSetting("probe-user", "bilibili");
    if (code === "LOGIN_REQUIRED") {
      expect(stored).toMatchObject({ credentialStatus: "invalid" });
    } else {
      expect(stored).toBeUndefined();
    }
  });

  it("persists validated login cookies", async () => {
    process.env.DATA_ENCRYPTION_KEY = "test-data-encryption-key-with-at-least-32-characters";
    await insertUser({
      email: "bilibili-credential@example.com",
      id: "bilibili-credential-user",
      passwordHash: "hash",
      termsAcceptedAt: Date.now(),
      username: "bilibili-credential-user",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      code: 0,
      data: { isLogin: true, mid: 42, uname: "bili-user" },
    })).mockResolvedValueOnce(jsonResponse({ code: 0, data: { list: [] } }));
    const valid = await validateAndStoreBilibiliCredential(
      "bilibili-credential-user",
      " Cookie: bili_jct=csrf ; SESSDATA=abc ; DedeUserID=42 ",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.bilibili.com/x/web-interface/nav");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ cookie: "SESSDATA=abc; bili_jct=csrf; DedeUserID=42" }),
    }));
    const probeUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(probeUrl.pathname).toBe("/x/v3/fav/folder/collected/list");
    expect(probeUrl.searchParams.get("ps")).toBe("1");
    expect(probeUrl.searchParams.get("up_mid")).toBe("42");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      cache: "no-store",
      headers: { cookie: valid.cookie },
    });
    expect(valid).toMatchObject({
      cookie: "SESSDATA=abc; bili_jct=csrf; DedeUserID=42",
      status: "valid",
      username: "bili-user",
    });
    await expect(readUserSetting("bilibili-credential-user", "bilibili")).resolves.toMatchObject({
      cookie: valid.cookie,
      credentialStatus: "valid",
      username: "bili-user",
    });
  });

  it("rejects incomplete cookies before making an upstream request", async () => {
    process.env.DATA_ENCRYPTION_KEY = "test-data-encryption-key-with-at-least-32-characters";
    await insertUser({
      email: "bilibili-invalid@example.com",
      id: "bilibili-invalid-user",
      passwordHash: "hash",
      termsAcceptedAt: Date.now(),
      username: "bilibili-invalid-user",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(validateAndStoreBilibiliCredential("bilibili-invalid-user", "bili_jct=csrf"))
      .rejects.toMatchObject({ code: "INVALID_COOKIE" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readUserSetting("bilibili-invalid-user", "bilibili")).resolves.toMatchObject({
      cookie: "bili_jct=csrf",
      credentialStatus: "invalid",
    });
  });
  it("stores cookies returned by the official QR login poll endpoint", async () => {
    process.env.DATA_ENCRYPTION_KEY = "test-data-encryption-key-with-at-least-32-characters";
    await insertUser({
      email: "bilibili-qrcode@example.com",
      id: "bilibili-qrcode-user",
      passwordHash: "hash",
      termsAcceptedAt: Date.now(),
      username: "bilibili-qrcode-user",
    });

    const responses = [
      jsonResponse({ code: 0, data: { qrcode_key: "qr-key", url: "https://passport.bilibili.com/qrcode" } }),
      jsonResponse({ code: 0, data: { code: 0, message: "ok" } }, [
        "SESSDATA=qr-session; Path=/; Domain=.bilibili.com",
        "bili_jct=qr-csrf; Path=/; Domain=.bilibili.com",
        "DedeUserID=42; Path=/; Domain=.bilibili.com",
      ]),
      jsonResponse({ code: 0, data: { isLogin: true, mid: 42, uname: "qr-user" } }),
      jsonResponse({ code: 0, data: { list: null } }),
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    });

    const session = await generateBilibiliQRCode();
    expect(session).toMatchObject({ qrcodeKey: "qr-key" });
    expect(session).not.toHaveProperty("url");
    expect(session.svg).toContain("<svg");

    const result = await pollBilibiliQRCode("bilibili-qrcode-user", session.qrcodeKey);
    expect(result.status).toBe("confirmed");
    await expect(readUserSetting("bilibili-qrcode-user", "bilibili")).resolves.toMatchObject({
      cookie: "SESSDATA=qr-session; bili_jct=qr-csrf; DedeUserID=42",
      credentialStatus: "valid",
      username: "qr-user",
    });
  });
});

function jsonResponse(payload: unknown, setCookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of setCookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(JSON.stringify(payload), { headers });
}
