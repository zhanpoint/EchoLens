import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readCurrentUserFromCookies, isAdminUser } from "@/lib/auth/service";
import { listAccountServiceInvitations } from "@/lib/invitations/service";
import { InvitationConsole } from "./page-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "控制台 | EchoLens",
};

export default async function Page() {
  const user = await readCurrentUserFromCookies();
  if (!isAdminUser(user)) notFound();

  return <InvitationConsole invitations={await listAccountServiceInvitations()} />;
}