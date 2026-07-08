import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { listTranscriptHistoryRecords } from "@/lib/transcript/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? undefined;
  return NextResponse.json({
    records: await listTranscriptHistoryRecords({
      query,
      userId: user.id,
    }),
  });
}
