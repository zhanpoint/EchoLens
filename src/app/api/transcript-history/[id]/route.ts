import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import {
  deleteTranscriptHistoryRecord,
  listTranscriptHistorySummaries,
  readTranscriptHistoryRecord,
  renameTranscriptHistoryRecord,
  updateTranscriptHistoryRecordTranscript,
} from "@/lib/transcript/db";

export const runtime = "nodejs";

const TranscriptSegmentSchema = z.object({
  endSeconds: z.number().finite().nonnegative(),
  emotion: z.string().optional(),
  speakerId: z.string().optional(),
  startSeconds: z.number().finite().nonnegative(),
  text: z.string().trim().min(1).max(20_000),
}).strict().refine((segment) => segment.endSeconds >= segment.startSeconds, {
  message: "segment endSeconds must be greater than or equal to startSeconds",
});

const UpdateHistoryRecordSchema = z.object({
  displayTitle: z.string().trim().min(1).max(120).optional(),
  transcriptContent: z.string().trim().min(1).max(200_000).optional(),
  transcriptSegments: z.array(TranscriptSegmentSchema).max(20_000).optional(),
}).strict()
  .refine((value) => value.displayTitle !== undefined || value.transcriptContent !== undefined, {
    message: "at least one update field is required",
  })
  .refine((value) => value.transcriptSegments === undefined || value.transcriptContent !== undefined, {
    message: "transcriptSegments requires transcriptContent",
  });

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const { id } = await context.params;
  const record = await readTranscriptHistoryRecord({ id, userId: user.id });
  if (!record) {
    return NextResponse.json({ error: "转录历史不存在。" }, { status: 404 });
  }

  return NextResponse.json({
    record,
    summaries: await listTranscriptHistorySummaries({
      historyRecordId: id,
      userId: user.id,
    }),
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = UpdateHistoryRecordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "历史记录更新参数无效。" }, { status: 400 });
  }

  const { id } = await context.params;
  let record = await readTranscriptHistoryRecord({ id, userId: user.id });
  if (!record) {
    return NextResponse.json({ error: "转录历史不存在。" }, { status: 404 });
  }

  if (parsed.data.displayTitle !== undefined) {
    record = await renameTranscriptHistoryRecord({
      displayTitle: parsed.data.displayTitle,
      id,
      userId: user.id,
    });
  }

  if (parsed.data.transcriptContent !== undefined) {
    record = await updateTranscriptHistoryRecordTranscript({
      id,
      transcriptContent: parsed.data.transcriptContent,
      transcriptSegments: parsed.data.transcriptSegments,
      userId: user.id,
    });
  }

  if (!record) {
    return NextResponse.json({ error: "转录历史不存在。" }, { status: 404 });
  }

  return NextResponse.json({ record });
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const { id } = await context.params;
  const deleted = await deleteTranscriptHistoryRecord({ id, userId: user.id });
  if (!deleted) {
    return NextResponse.json({ error: "转录历史不存在。" }, { status: 404 });
  }

  return NextResponse.json({ deleted: true });
}
