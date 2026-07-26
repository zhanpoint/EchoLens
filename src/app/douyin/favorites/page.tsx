import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isDouyinAccountServicesEnabled } from "@/lib/douyin/account-services";
import { DouyinFavoritesPage } from "./page-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "收藏与关注 | EchoLens",
};

export default function Page() {
  if (!isDouyinAccountServicesEnabled()) notFound();
  return <DouyinFavoritesPage />;
}
