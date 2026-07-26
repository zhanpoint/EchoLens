import type { Metadata } from "next";
import { SettingsPage } from "./page-client";

export const metadata: Metadata = {
  title: "设置 | EchoLens",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const { section } = await searchParams;
  return <SettingsPage initialSection={section === "douyin" || section === "download" ? section : "aiCredential"} />;
}
