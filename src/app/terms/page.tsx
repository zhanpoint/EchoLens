import type { Metadata } from "next";
import { LegalDocument } from "../legal/legal-document";
import { termsSections } from "../legal/content";

export const metadata: Metadata = {
  title: "用户协议 | EchoLens",
  description: "EchoLens 用户协议",
};

export default function TermsPage() {
  return (
    <LegalDocument
      title="用户协议"
      description="请在注册或登录前阅读本协议。继续使用 EchoLens，即表示你理解并同意账号安全、使用规则与服务边界。"
      sections={termsSections}
    />
  );
}
