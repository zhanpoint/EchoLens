import { describe, expect, it, vi } from "vitest";

const authService = vi.hoisted(() => {
  class TestAuthError extends Error {
    constructor(message: string, readonly status = 400, readonly code = "AUTH_ERROR") {
      super(message);
    }
  }

  return {
    AuthError: TestAuthError,
    loginUser: vi.fn(),
    loginUserWithEmailCode: vi.fn(),
    setSessionCookie: vi.fn(),
  };
});

vi.mock("@/lib/auth/service", () => authService);
vi.mock("@/lib/auth/rate-limit", () => ({
  AuthRateLimitError: class AuthRateLimitError extends Error {},
  clearAuthIdentityRateLimit: vi.fn(),
  enforceAuthRateLimits: vi.fn(),
  readClientAddress: vi.fn(() => "127.0.0.1"),
}));

import { POST } from "@/app/api/auth/login/route";

const user = { email: "reader@example.com", id: "user-1", username: "reader" };

describe("auth login route", () => {
  it("keeps username and password login as the default method", async () => {
    authService.loginUser.mockResolvedValueOnce(user);
    authService.setSessionCookie.mockResolvedValueOnce(undefined);

    const response = await POST(new Request("https://echolens.test/api/auth/login", {
      body: JSON.stringify({
        acceptedLegal: true,
        identifier: "reader",
        password: "Aa123456!",
      }),
      method: "POST",
    }));

    expect(response.status).toBe(200);
    expect(authService.loginUser).toHaveBeenCalledWith({
      acceptedLegal: true,
      identifier: "reader",
      password: "Aa123456!",
    });
    expect(authService.loginUserWithEmailCode).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ user });
  });

  it("supports email code login", async () => {
    authService.loginUserWithEmailCode.mockResolvedValueOnce(user);
    authService.setSessionCookie.mockResolvedValueOnce(undefined);

    const response = await POST(new Request("https://echolens.test/api/auth/login", {
      body: JSON.stringify({
        acceptedLegal: true,
        code: "123456",
        email: "reader@example.com",
        method: "code",
      }),
      method: "POST",
    }));

    expect(response.status).toBe(200);
    expect(authService.loginUserWithEmailCode).toHaveBeenCalledWith({
      acceptedLegal: true,
      code: "123456",
      email: "reader@example.com",
    });
    expect(await response.json()).toEqual({ user });
  });

  it("returns a generic credential failure from auth service", async () => {
    authService.loginUser.mockRejectedValueOnce(new authService.AuthError(
      "账号或密码错误。",
      401,
      "INVALID_CREDENTIALS",
    ));

    const response = await POST(new Request("https://echolens.test/api/auth/login", {
      body: JSON.stringify({
        acceptedLegal: true,
        identifier: "reader@example.com",
        method: "password",
        password: "Wrong123!",
      }),
      method: "POST",
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "INVALID_CREDENTIALS",
      error: "账号或密码错误。",
    });
  });
});
