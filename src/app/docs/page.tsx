import type { Metadata } from "next";
import { getOpenApiBaseUrl } from "@/lib/open-api/base-url";
import { DocsPage } from "./page-client";

export const metadata: Metadata = {
  title: "文档 | EchoLens",
  description: "EchoLens 媒体解析与音频转录的 API、MCP 和 Skill 接入文档",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const { section } = await searchParams;
  return <DocsPage initialSection={section} openApiBaseUrl={getOpenApiBaseUrl()} />;
}
