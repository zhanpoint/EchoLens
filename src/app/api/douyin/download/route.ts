import { NextResponse } from "next/server";
import { z } from "zod";
import { collectWorkMetadata } from "@/lib/douyin/detail";
import { buildDouyinWorkUrl, canDownloadAsset } from "@/lib/douyin/download";
import type { DouyinWorkMetadata } from "@/lib/douyin/detail";
import { DOUYIN_KINDS, MEDIA_ASSET_KINDS, type MediaAssetKind } from "@/types/douyin";

export const runtime = "nodejs";
export const maxDuration = 120;

const DownloadQuerySchema = z.object({
  id: z.string().regex(/^\d{6,30}$/),
  kind: z.enum(DOUYIN_KINDS),
  asset: z.enum(MEDIA_ASSET_KINDS),
});

const MEDIA_DOMAINS = [
  "douyinpic.com",
  "douyinvod.com",
  "douyinstatic.com",
  "byteimg.com",
] as const;

const UPSTREAM_ACCEPT: Record<MediaAssetKind, string> = {
  cover: "image/*,*/*;q=0.8",
  video: "video/mp4,*/*;q=0.8",
  audio: "audio/*,*/*;q=0.8",
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = DownloadQuerySchema.safeParse({
    id: url.searchParams.get("id"),
    kind: url.searchParams.get("kind"),
    asset: url.searchParams.get("asset"),
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "下载参数无效。" }, { status: 400 });
  }

  const { id, kind, asset } = parsed.data;
  const isPreview = asset === "cover" && url.searchParams.get("preview") === "1";
  if (!canDownloadAsset(kind, asset)) {
    return NextResponse.json({ error: "当前作品类型不支持该下载资源。" }, { status: 400 });
  }

  const finalUrl = buildDouyinWorkUrl(kind, id);
  const metadata = await collectWorkMetadata({ id, kind, finalUrl });
  const assetUrl = selectAssetUrl(asset, metadata);

  if (!assetUrl) {
    return NextResponse.json({ error: "没有采集到可下载资源。" }, { status: 404 });
  }
  if (!isAllowedMediaUrl(assetUrl)) {
    return NextResponse.json({ error: "资源地址不在允许的下载域名内。" }, { status: 400 });
  }

  const upstream = await fetch(assetUrl, {
    headers: {
      accept: UPSTREAM_ACCEPT[asset],
      referer: "https://www.douyin.com/",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: `下载资源读取失败：HTTP ${upstream.status}。` }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? defaultContentType(asset);
  const headers = new Headers({
    "content-type": contentType,
    "content-disposition": `${isPreview ? "inline" : "attachment"}; filename="${buildFilename(id, asset, contentType)}"`,
    "cache-control": "no-store",
  });
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) {
    headers.set("content-length", contentLength);
  }

  return new Response(upstream.body, { headers });
}

function selectAssetUrl(
  asset: MediaAssetKind,
  metadata: DouyinWorkMetadata,
): string | undefined {
  return {
    cover: metadata.coverUrl,
    video: metadata.videoUrl,
    audio: metadata.audioUrls?.[0],
  }[asset];
}

function isAllowedMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      MEDIA_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
    );
  } catch {
    return false;
  }
}

function buildFilename(
  id: string,
  asset: MediaAssetKind,
  contentType: string,
): string {
  return `echolens-${id}-${asset}.${readExtension(asset, contentType)}`;
}

function readExtension(asset: MediaAssetKind, contentType: string): string {
  if (contentType.includes("webp")) {
    return "webp";
  }
  if (contentType.includes("png")) {
    return "png";
  }
  if (contentType.includes("jpeg") || contentType.includes("jpg")) {
    return "jpg";
  }
  if (contentType.includes("mpeg")) {
    return "mp3";
  }
  if (contentType.includes("mp4")) {
    return asset === "audio" ? "m4a" : "mp4";
  }

  return asset === "cover" ? "jpg" : asset === "audio" ? "m4a" : "mp4";
}

function defaultContentType(asset: MediaAssetKind): string {
  if (asset === "cover") {
    return "image/jpeg";
  }
  if (asset === "audio") {
    return "audio/mp4";
  }
  return "video/mp4";
}
