import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readCurrentUserFromCookies } from "@/lib/auth/service";
import { canUseDouyinAccountServices } from "@/lib/douyin/account-services";
import { DouyinFollowingPage } from "./page-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "收藏与关注 | EchoLens",
};

export default async function Page() {
  if (!canUseDouyinAccountServices(await readCurrentUserFromCookies())) notFound();
  return <DouyinFollowingPage />;
}
