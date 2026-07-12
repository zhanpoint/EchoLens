import { describe, expect, it } from "vitest";
import { buildAuthEmailContent } from "@/lib/auth/email";

describe("auth email templates", () => {
  it("renders branded verification email with inline logo", () => {
    const content = buildAuthEmailContent({
      code: "123456",
      copy: {
        description: "感谢注册 EchoLens，请使用以下验证码完成账号创建。",
        subject: "EchoLens - 注册验证码",
        title: "欢迎注册 EchoLens",
      },
    });

    expect(content.html).toContain("cid:echolens-logo");
    expect(content.html).toContain("EchoLens");
    expect(content.html).toContain("123456");
    expect(content.text).toContain("验证码: 123456");
  });
});
