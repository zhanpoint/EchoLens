import { NextResponse } from "next/server";
import { requireUser } from "@/app/api/auth/_shared";
import { rejectDisabledDouyinAccountServices } from "../_account-services";
import { collectDouyinFollowingUsers } from "@/lib/douyin/following";
import { DouyinApiError } from "@/lib/douyin/web-client";
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
    const users = await collectDouyinFollowingUsers(cookie, { signal: request.signal });
    return NextResponse.json({ refreshedAt: Date.now(), users });
  } catch (error) {
    if (error instanceof DouyinApiError) {
      return toDouyinApiErrorResponse(error, user.id);
    }
    return NextResponse.json({ error: "抖音关注列表获取失败。", code: "UPSTREAM_ERROR" }, { status: 502 });
  }
}
