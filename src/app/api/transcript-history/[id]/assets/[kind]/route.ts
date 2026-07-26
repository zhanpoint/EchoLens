import { NextResponse } from "next/server";
import { z } from "zod";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";
import { ensureHistoryAsset } from "@/lib/transcript/assets";

export const runtime = "nodejs";
export const maxDuration = 600;

const AssetKindSchema = z.enum(["avatar", "cover", "video", "originalAudio"]);

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
      return NextResponse.json({ error: "会话不存在。" }, { status: 404 });
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