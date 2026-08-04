import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { readBilibiliHistoryVideoFile } from "@/lib/transcript/assets";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const { id } = await context.params;
  const cached = await readBilibiliHistoryVideoFile({ historyRecordId: id, userId: user.id });
  if (!cached) {
    return NextResponse.json({ error: "Bilibili 视频缓存不存在或已过期，请重新获取。" }, { status: 404 });
  }

  const range = parseRange(request.headers.get("range"), cached.sizeBytes);
  if (range === null) {
    return new Response(null, {
      headers: { "content-range": `bytes */${cached.sizeBytes}` },
      status: 416,
    });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? cached.sizeBytes - 1;
  const contentLength = end - start + 1;
  const body = Readable.toWeb(createReadStream(cached.filePath, { end, start })) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-length": String(contentLength),
      "content-type": cached.contentType,
      ...(range ? { "content-range": `bytes ${start}-${end}/${cached.sizeBytes}` } : {}),
    },
    status: range ? 206 : 200,
  });
}

function parseRange(value: string | null, sizeBytes: number): { end: number; start: number } | null | undefined {
  if (!value) return undefined;
  const match = value.match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { end: sizeBytes - 1, start: Math.max(0, sizeBytes - suffixLength) };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : sizeBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= sizeBytes ||
    requestedEnd < start
  ) return null;
  return { end: Math.min(requestedEnd, sizeBytes - 1), start };
}