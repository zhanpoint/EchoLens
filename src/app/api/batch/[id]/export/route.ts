import { Readable } from "node:stream";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { readBatch, readBatchExport } from "@/lib/batch/db";
import { exportFilename, exportTranscripts } from "@/lib/batch/export";
import { ExportFormatSchema } from "@/lib/batch/contracts";

export const runtime = "nodejs";
const QuerySchema = z.object({
  format: ExportFormatSchema.default("md"),
  position: z.coerce.number().int().min(0).max(4999).optional(),
  after: z.coerce.number().int().min(-1).max(4999).optional(),
  asOf: z.coerce.number().int().positive().optional(),
});
const contentTypes = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
};
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const query = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return Response.json({ error: "导出格式或作品序号无效。" }, { status: 400 });
  const { format, position, after } = query.data;
  const asOf = query.data.asOf ?? Date.now();
  const { id } = await context.params;
  const batch = await readBatch(user.id, id, position ?? 0);
  if (!batch) return Response.json({ error: "任务不存在。" }, { status: 404 });
  const item = position === undefined ? null : batch.items.find((item) => item.position === position);
  if (position !== undefined && !item) return Response.json({ error: "作品不存在。" }, { status: 404 });
  if (!batch.job.succeeded || (item && item.status !== "succeeded"))
    return Response.json(
      { error: "还没有可以导出的转录结果。" },
      { status: 409 },
    );
  const filename = item ? exportFilename({ ...item.video, position: item.position }, format) : `echolens-${id}.${format}`;
  const stream = Readable.toWeb(
    Readable.from(
      exportTranscripts(
        readBatchExport(user.id, id, { asOf, position, after, limit: after === undefined ? undefined : 50 }),
        batch.job.platform,
        format,
      ),
    ),
  );
  return new Response(stream as ReadableStream<Uint8Array>, {
    headers: {
      "content-type": contentTypes[format],
      "content-disposition": `attachment; filename="echolens-${id}${position === undefined ? "" : `-${position + 1}`}.${format}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/gu, (char) => `%${char.charCodeAt(0).toString(16)}`)}`,
      "cache-control": "private, no-store",
      "x-export-as-of": String(asOf),
    },
  });
}
