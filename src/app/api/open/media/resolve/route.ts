import { NextResponse } from "next/server";
import { requireOpenApiUser } from "@/lib/open-api/auth";
import { OpenMediaResolveSchema } from "@/lib/open-api/contracts";
import { openApiErrorResponse } from "@/lib/open-api/error-response";
import { resolveOpenMediaResources } from "@/lib/open-api/media-resource";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireOpenApiUser(request);
  if (user instanceof Response) return user;

  const parsed = OpenMediaResolveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "inputs 必须是包含 1 到 10 个抖音或 Bilibili 分享链接的列表。" }, { status: 400 });
  }

  try {
    const media = await resolveOpenMediaResources({ inputs: parsed.data.inputs, userId: user.id });
    return NextResponse.json({ media });
  } catch (error) {
    return openApiErrorResponse(error, "获取媒体资源失败，请稍后重试。");
  }
}