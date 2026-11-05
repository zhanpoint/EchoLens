import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { readDouyinCredentialState } from "@/lib/douyin/account";
import { fetchRemoteMedia } from "@/lib/media/audio";
import { ensureHistoryAsset } from "@/lib/transcript/assets";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;
  const { id } = await context.params;
  try {
    const asset = await ensureHistoryAsset({ assetKind: "video", historyRecordId: id, userId: user.id, signal: request.signal });
    if (!asset) return NextResponse.json({ error: "视频不可用。" }, { status: 404 });
    const credential = await readDouyinCredentialState(user.id);
    const upstream = await fetchRemoteMedia(asset.url, {
      mediaSource: "douyin",
      douyinCookie: credential.status === "valid" ? credential.cookie : undefined,
      range: request.headers.get("range"),
      signal: request.signal,
    });
    const headers = new Headers({ "cache-control": "private, no-store", "content-type": upstream.headers.get("content-type") || "video/mp4" });
    for (const name of ["accept-ranges", "content-length", "content-range"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return NextResponse.json({ error: "视频加载失败，请检查抖音凭证后重试。" }, { status: 502 });
  }
}
