import { NextResponse } from "next/server";
import { ensurePostgresSchema } from "@/lib/storage/postgres";

export async function GET() {
  try {
    await ensurePostgresSchema();
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
}
