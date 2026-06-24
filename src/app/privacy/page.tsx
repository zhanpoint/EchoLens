import type { Metadata } from "next";
import { privacySections } from "../legal/content";
import { LegalDocument } from "../legal/legal-document";

export const metadata: Metadata = {
  title: "隐私政策 | EchoLens",
  description: "EchoLens 隐私政策",
};

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="隐私政策"
      description="本政策说明 EchoLens 在账号、验证、会话和服务安全场景中处理数据的范围与用途。"
      sections={privacySections}
    />
  );
}
