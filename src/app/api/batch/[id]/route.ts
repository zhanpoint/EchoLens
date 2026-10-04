import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { controlBatch, readBatch } from "@/lib/batch/db";
import { startBatchWorker } from "@/lib/batch/worker";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const offset = Math.max(
    0,
    Math.floor(Number(new URL(request.url).searchParams.get("offset")) || 0),
  );
  const batch = await readBatch(user.id, id, offset);
  return batch
    ? Response.json(batch)
    : Response.json({ error: "任务不存在。" }, { status: 404 });
}
export async function PATCH(request: Request, context: Context) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const parsed = z
    .object({ action: z.enum(["pause", "resume", "retry", "cancel"]), itemId: z.uuid().optional() })
    .refine(({ action, itemId }) => !itemId || action === "retry")
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "任务操作无效。" }, { status: 400 });
  const { id } = await context.params;
  const found = await controlBatch(user.id, id, parsed.data.action, parsed.data.itemId);
  if (found) startBatchWorker();
  return found
    ? Response.json({ ok: true })
    : Response.json({ error: "任务或可重试作品不存在。" }, { status: 404 });
}
