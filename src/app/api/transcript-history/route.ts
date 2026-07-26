import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { deleteTranscriptHistoryRecord, listTranscriptHistoryRecords } from "@/lib/transcript/db";

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

export async function DELETE(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) {
    return NextResponse.json({ error: "缺少转录历史 ID。" }, { status: 400 });
  }

  const deleted = await deleteTranscriptHistoryRecord({ id, userId: user.id });
  if (!deleted) {
    return NextResponse.json({ error: "转录历史不存在。" }, { status: 404 });
  }

  return NextResponse.json({ deleted: true });
}
