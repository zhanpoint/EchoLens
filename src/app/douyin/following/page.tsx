import type { Metadata } from "next";
import { DouyinFollowingPage } from "./page-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "收藏与关注 | EchoLens",
};

export default function Page() {
  return <DouyinFollowingPage />;
}
