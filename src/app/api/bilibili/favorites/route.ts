import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { readUsableBilibiliCookie } from "@/lib/bilibili/account";
import { BilibiliFavoriteError, collectBilibiliFavorites } from "@/lib/bilibili/favorites";
import { readUserSetting } from "@/lib/user-settings";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const settings = await readUserSetting(user.id, "bilibili");
  const cookie = readUsableBilibiliCookie(settings);
  if (!cookie) {
    return NextResponse.json({
      code: "CREDENTIAL_INVALID",
      error: "请前往设置登录 Bilibili 后重试。",
    }, { status: 409 });
  }

  try {
    const snapshot = await collectBilibiliFavorites({ cookie });
    return NextResponse.json({ ...snapshot, refreshedAt: Date.now() });
  } catch (error) {
    if (error instanceof BilibiliFavoriteError) {
      const status = error.code === "LOGIN_REQUIRED" ? 409 : 502;
      return NextResponse.json({ code: error.code, error: error.message }, { status });
    }
    return NextResponse.json({ code: "UPSTREAM_ERROR", error: "Bilibili 收藏列表获取失败。" }, { status: 502 });
  }
}