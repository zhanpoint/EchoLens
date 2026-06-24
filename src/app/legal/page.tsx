import type { Metadata } from "next";
import { legalSections } from "./content";
import { LegalDocument } from "./legal-document";

export const metadata: Metadata = {
  title: "法律声明 | EchoLens",
  description: "EchoLens 法律声明、使用边界、版权说明与免责声明",
};

export default function LegalPage() {
  return (
    <LegalDocument
      title="法律声明"
      description="请在使用 EchoLens 前阅读本声明。继续使用本项目，即表示你确认已理解本项目的定位、使用边界、风险责任与权利说明，并同意自行遵守相关法律法规和平台规则。"
      sections={legalSections}
    />
  );
}
