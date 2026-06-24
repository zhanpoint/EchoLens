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

  it("renders login notice without exposing unsafe HTML", () => {
    const content = buildAuthEmailContent({
      copy: {
        description: "你的 EchoLens 账户刚刚完成登录。如果不是你本人操作，请尽快重置密码。",
        subject: "EchoLens - 登录提醒",
        title: "登录提醒",
      },
      username: "<admin>",
    });

    expect(content.html).toContain("&lt;admin&gt;");
    expect(content.html).not.toContain("<admin>");
    expect(content.text).toContain("登录账户: <admin>");
  });
});
