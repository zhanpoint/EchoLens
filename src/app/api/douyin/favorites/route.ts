import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { rejectDisabledDouyinAccountServices } from "../_account-services";
import { collectDouyinFavorites, DouyinApiError } from "@/lib/douyin/favorites";
import { readValidDouyinCredential, toDouyinApiErrorResponse } from "../_credential";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const disabled = rejectDisabledDouyinAccountServices(user);
  if (disabled) return disabled;

  const cookie = await readValidDouyinCredential(user.id);
  if (cookie instanceof NextResponse) {
    return cookie;
  }
  try {
    const snapshot = await collectDouyinFavorites({ cookie });
    return NextResponse.json({ ...snapshot, refreshedAt: Date.now() });
  } catch (error) {
    if (error instanceof DouyinApiError) {
      return toDouyinApiErrorResponse(error, user.id);
    }
    return NextResponse.json({ error: "抖音收藏列表获取失败。", code: "UPSTREAM_ERROR" }, { status: 502 });
  }
}
