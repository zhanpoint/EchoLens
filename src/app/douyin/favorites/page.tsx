import type { Metadata } from "next";
import { DouyinFavoritesPage } from "./page-client";

export const metadata: Metadata = {
  title: "收藏与关注 | EchoLens",
};

export default function Page() {
  return <DouyinFavoritesPage />;
}
