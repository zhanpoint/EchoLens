import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { fetchAuthorVideos, resolveAuthorId } from "@/lib/batch/author-videos";
import { PlatformSchema } from "@/lib/batch/contracts";
import { rejectDisabledDouyinAccountServices } from "@/app/api/douyin/_account-services";
import { DouyinApiError } from "@/lib/douyin/web-client";
import { toDouyinApiErrorResponse } from "@/app/api/douyin/_credential";
import { OpenApiPlatformCooldownError } from "@/lib/open-api/platform-request-policy";

export const runtime = "nodejs";
const Schema = z.object({
  platform: PlatformSchema,
  input: z.string().trim().min(1).max(2000),
  cursor: z.string().max(20).optional(),
});
export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: parsed.error.issues[0]?.message || "用户主页或分页参数无效。" }, { status: 400 });
  if (parsed.data.platform === "douyin") {
    const disabled = rejectDisabledDouyinAccountServices(user);
    if (disabled) return disabled;
  }
  try {
    const authorId = await resolveAuthorId(
      parsed.data.platform,
      parsed.data.input,
    );
    return Response.json(
      await fetchAuthorVideos({
        ...parsed.data,
        authorId,
        userId: user.id,
        signal: request.signal,
      }),
    );
  } catch (error) {
    if (error instanceof OpenApiPlatformCooldownError)
      return Response.json(
        {
          code: "RATE_LIMITED",
          error: `${parsed.data.platform === "douyin" ? "抖音" : "Bilibili"}暂时限制了访问，请稍后继续获取。`,
          retryAfterSeconds: error.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(error.retryAfterSeconds) },
        },
      );
    if (error instanceof DouyinApiError)
      return toDouyinApiErrorResponse(error, user.id);
    return Response.json(
      { error: error instanceof Error ? error.message : "作品列表加载失败。" },
      { status: 502 },
    );
  }
}
