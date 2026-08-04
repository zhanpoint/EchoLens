import { NextResponse } from "next/server";
import { z } from "zod";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";
import {
  ensureBilibiliHistoryVideo,
  ensureHistoryAsset,
} from "@/lib/transcript/assets";

export const runtime = "nodejs";
export const maxDuration = 600;

const AssetKindSchema = z.enum(["avatar", "cover", "video", "originalAudio"]);
const BILIBILI_VIDEO_CACHE_MISSING_CODE = "BILIBILI_VIDEO_CACHE_MISSING";

type RouteContext = {
  params: Promise<{ id: string; kind: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const { id, kind } = await context.params;
  const parsedKind = AssetKindSchema.safeParse(kind);
  if (!parsedKind.success) {
    return NextResponse.json({ error: "资源类型无效。" }, { status: 400 });
  }

  try {
    const asset = await ensureHistoryAsset({
      assetKind: parsedKind.data,
      historyRecordId: id,
      userId: user.id,
    });
    if (!asset) {
      return parsedKind.data === "video"
        ? NextResponse.json({
            code: BILIBILI_VIDEO_CACHE_MISSING_CODE,
            error: "Bilibili 视频缓存不存在或已过期，请先获取视频资源。",
          }, { status: 404 })
        : NextResponse.json({ error: "会话不存在。" }, { status: 404 });
    }

    return NextResponse.json(
      {
        asset: {
          ...asset,
          ...(parsedKind.data === "originalAudio" && asset.verifiedAt
            ? { verified: true }
            : {}),
        },
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    logServerError(`transcript-history.assets.${parsedKind.data}`, error);
    const networkFailure = error instanceof NetworkRetryExhaustedError;
    return NextResponse.json(
      {
        ...(networkFailure ? { code: NETWORK_RETRY_ERROR_CODE } : {}),
        error: networkFailure ? NETWORK_RETRY_ERROR_MESSAGE : "资源准备失败，请稍后重试。",
      },
      { status: 502 },
    );
  }
}

export async function POST(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const { id, kind } = await context.params;
  if (kind !== "video") {
    return NextResponse.json({ error: "只有 Bilibili 视频资源支持手动获取。" }, { status: 400 });
  }

  try {
    const asset = await ensureBilibiliHistoryVideo({ historyRecordId: id, userId: user.id });
    if (!asset) {
      return NextResponse.json({ error: "会话不存在或不是 Bilibili 视频。" }, { status: 404 });
    }
    return NextResponse.json({ asset }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    logServerError("transcript-history.assets.video.generate", error);
    const networkFailure = error instanceof NetworkRetryExhaustedError;
    return NextResponse.json(
      {
        ...(networkFailure ? { code: NETWORK_RETRY_ERROR_CODE } : {}),
        error: networkFailure ? NETWORK_RETRY_ERROR_MESSAGE : "Bilibili 视频资源获取失败，请稍后重试。",
      },
      { status: 502 },
    );
  }
}