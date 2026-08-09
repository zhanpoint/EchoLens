import type { Metadata } from "next";
import { getOpenApiBaseUrl } from "@/lib/open-api/base-url";
import { DocsPage } from "./page-client";

export const metadata: Metadata = {
  title: "文档 | EchoLens",
  description: "EchoLens API、MCP 与 CLI 调用文档",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const { section } = await searchParams;
  return <DocsPage initialSection={section} openApiBaseUrl={getOpenApiBaseUrl()} />;
}