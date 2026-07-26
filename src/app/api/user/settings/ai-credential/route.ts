import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { readUserSetting } from "@/lib/user-settings";

export const runtime = "nodejs";

type AiCredentialSetting = {
  apiKey?: unknown;
};

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const setting = await readUserSetting(user.id, "aiCredential") as AiCredentialSetting | undefined;
  const apiKey = typeof setting?.apiKey === "string" ? setting.apiKey.trim() : "";
  return NextResponse.json(
    { apiKey },
    { headers: { "Cache-Control": "no-store" } },
  );
}
