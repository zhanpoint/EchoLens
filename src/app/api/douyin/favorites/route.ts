import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { markDouyinCredentialInvalid } from "@/lib/douyin/account";
import { collectDouyinFavorites, DouyinApiError } from "@/lib/douyin/favorites";
import { readValidDouyinCredential } from "../_credential";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const cookie = await readValidDouyinCredential(user.id);
  if (cookie instanceof NextResponse) {
    return cookie;
  }
  try {
    const snapshot = await collectDouyinFavorites({ cookie });
    return NextResponse.json({ ...snapshot, refreshedAt: Date.now() });
  } catch (error) {
    if (error instanceof DouyinApiError) {
      if (error.code === "LOGIN_REQUIRED" || error.code === "INVALID_COOKIE") {
        await markDouyinCredentialInvalid(user.id);
        return NextResponse.json({
          code: "CREDENTIAL_INVALID",
          error: "抖音账号访问凭证已失效，请前往设置更新后重试。",
        }, { status: 409 });
      }
      const status = error.code === "UPSTREAM_ERROR" ? 502 : 400;
      return NextResponse.json({ code: error.code, error: error.message }, { status });
    }
    return NextResponse.json({ error: "抖音收藏列表获取失败。", code: "UPSTREAM_ERROR" }, { status: 502 });
  }
}
