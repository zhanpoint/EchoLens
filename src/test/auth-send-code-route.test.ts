import { beforeEach, describe, expect, it, vi } from "vitest";

const authService = vi.hoisted(() => {
  class TestAuthError extends Error {
    constructor(message: string, readonly status = 400, readonly code = "AUTH_ERROR") {
      super(message);
    }
  }

  return {
    AuthError: TestAuthError,
    emailExists: vi.fn(() => true),
  };
});

const authEmail = vi.hoisted(() => {
  class TestEmailRateLimitError extends Error {
    constructor(readonly waitSeconds: number) {
      super(`发送过于频繁，请 ${waitSeconds} 秒后再试。`);
    }
  }

  return {
    EmailRateLimitError: TestEmailRateLimitError,
    sendEmailCode: vi.fn(),
  };
});

vi.mock("@/lib/auth/service", () => authService);
vi.mock("@/lib/auth/email", () => authEmail);
vi.mock("@/lib/auth/rate-limit", () => ({
  AuthRateLimitError: class AuthRateLimitError extends Error {},
  enforceAuthRateLimits: vi.fn(),
  readClientAddress: vi.fn(() => "127.0.0.1"),
}));

import { POST } from "@/app/api/auth/send-code/route";

describe("auth send-code route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authService.emailExists.mockReturnValue(true);
  });

  it("accepts login email verification codes", async () => {
    authEmail.sendEmailCode.mockResolvedValueOnce(undefined);

    const response = await POST(new Request("https://echolens.test/api/auth/send-code", {
      body: JSON.stringify({
        email: "reader@example.com",
        purpose: "login",
      }),
      method: "POST",
    }));

    expect(response.status).toBe(200);
    expect(authEmail.sendEmailCode).toHaveBeenCalledWith("reader@example.com", "login");
    expect(await response.json()).toMatchObject({ expiresIn: 300 });
  });

  it("rejects login codes for unregistered emails", async () => {
    authService.emailExists.mockReturnValueOnce(false);

    const response = await POST(new Request("https://echolens.test/api/auth/send-code", {
      body: JSON.stringify({
        email: "missing@example.com",
        purpose: "login",
      }),
      method: "POST",
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "EMAIL_NOT_REGISTERED",
      error: "邮箱未注册。",
    });
    expect(authEmail.sendEmailCode).not.toHaveBeenCalled();
  });
});
