import { requireUser } from "@/app/api/auth/_shared";
import { CreateBatchSchema } from "@/lib/batch/contracts";
import { createBatch, listBatches } from "@/lib/batch/db";
import { startBatchWorker } from "@/lib/batch/worker";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  return Response.json({ jobs: await listBatches(user.id) });
}
export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const parsed = CreateBatchSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return Response.json(
      { error: "请选择 1–5000 个视频并指定转录模型。" },
      { status: 400 },
    );
  try {
    const id = await createBatch(user.id, parsed.data);
    startBatchWorker();
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    console.error("[batch.create]", error);
    return Response.json(
      { error: "创建批量任务失败，请检查视频标识后重试。" },
      { status: 400 },
    );
  }
}
