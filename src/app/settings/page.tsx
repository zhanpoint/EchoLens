import type { Metadata } from "next";
import { readCurrentUserFromCookies } from "@/lib/auth/service";
import { canUseDouyinAccountServices } from "@/lib/douyin/account-services";
import { SettingsPage } from "./page-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "设置 | EchoLens",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const { section } = await searchParams;
  const douyinAccountServicesEnabled = canUseDouyinAccountServices(await readCurrentUserFromCookies());
  return (
    <SettingsPage
      douyinAccountServicesEnabled={douyinAccountServicesEnabled}
      initialSection={
        (section === "douyin" && douyinAccountServicesEnabled) || section === "download"
          ? section
          : "aiCredential"
      }
    />
  );
}
