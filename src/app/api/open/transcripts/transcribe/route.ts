import { OpenTranscriptionSchema } from "@/lib/open-api/contracts";
import { openApiErrorResponse } from "@/lib/open-api/error-response";
import { requireOpenApiUser } from "@/lib/open-api/auth";
import { createOpenTranscription } from "@/lib/open-api/operation-gateway";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(request: Request) {
  const user = await requireOpenApiUser(request);
  if (user instanceof Response) return user;

  const parsed = OpenTranscriptionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "input 必须是抖音或 Bilibili 分享链接。" }, { status: 400 });
  }

  try {
    return await createOpenTranscription({
      ...parsed.data,
      signal: request.signal,
      userId: user.id,
    });
  } catch (error) {
    return openApiErrorResponse(error, "转录失败，请稍后重试。");
  }
}