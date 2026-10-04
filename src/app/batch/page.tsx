import type { Metadata } from "next";
import { BatchPage } from "./page-client";

export const metadata: Metadata = { title: "博主语料采集 | EchoLens" };
export default function Page() {
  return <BatchPage />;
}
