import type { Metadata } from "next";
import { SettingsPage } from "./page-client";

export const metadata: Metadata = {
  title: "设置 | EchoLens",
};

export default function Page() {
  return <SettingsPage />;
}
