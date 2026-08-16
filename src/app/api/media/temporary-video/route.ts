import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { acquireTemporaryVideo, temporaryVideoCacheKey } from "@/lib/media/temporary-video-cache";
import { readTranscriptHistoryRecord } from "@/lib/transcript/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const url = new URL(request.url);
  const historyRecordId = url.searchParams.get("historyRecordId")?.trim();
  const cacheKey = url.searchParams.get("cacheKey")?.trim();
  if (!historyRecordId || !cacheKey) {
    return NextResponse.json({ error: "临时视频参数无效。" }, { status: 400 });
  }

  const history = await readTranscriptHistoryRecord({ id: historyRecordId, userId: user.id });
  const expectedKey = history
    ? temporaryVideoCacheKey(`${history.workKey}:${history.mediaQuality ?? "default"}`)
    : "";
  if (!history || cacheKey !== expectedKey) {
    return NextResponse.json({ error: "临时视频不存在。" }, { status: 404 });
  }

  const lease = await acquireTemporaryVideo(cacheKey);
  if (!lease) {
    return NextResponse.json({ error: "临时视频已过期，请重新获取。" }, { status: 410 });
  }

  const range = parseRange(request.headers.get("range"), lease.sizeBytes);
  if (range === null) {
    lease.release();
    return new Response(null, {
      headers: { "content-range": `bytes */${lease.sizeBytes}` },
      status: 416,
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? lease.sizeBytes - 1;
  const nodeStream = createReadStream(lease.filePath, { end, start });
  nodeStream.once("close", lease.release);
  nodeStream.once("error", lease.release);

  return new Response(Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>, {
    headers: {
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-length": String(end - start + 1),
      "content-type": "video/mp4",
      ...(range ? { "content-range": `bytes ${start}-${end}/${lease.sizeBytes}` } : {}),
    },
    status: range ? 206 : 200,
  });
}

function parseRange(value: string | null, size: number): { end: number; start: number } | null | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0));
  const end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { end: Math.min(end, size - 1), start };
}