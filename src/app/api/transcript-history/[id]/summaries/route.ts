import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { streamSummarizeTranscript } from "@/lib/openrouter/provider";
import {
  insertTranscriptHistorySummary,
  readTranscriptHistoryRecord,
  type TranscriptHistorySummary,
} from "@/lib/transcript/db";
import { withUserRouteConcurrency } from "@/lib/user-concurrency";

export const runtime = "nodejs";
export const maxDuration = 120;

const SummarySchema = z.object({
  prompt: z.string().min(1).max(2000),
  promptId: z.string().min(1).max(128),
  promptTitle: z.string().min(1).max(120),
}).strict();

type RouteContext = {
  params: Promise<{ id: string }>;
};

type SummaryEvent =
  | { type: "delta"; value: string }
  | { summary: TranscriptHistorySummary; type: "done"; value: string }
  | { type: "error"; error: string; code?: string };

export async function POST(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = SummarySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "总结参数无效。" }, { status: 400 });
  }

  const { id } = await context.params;
  const record = await readTranscriptHistoryRecord({ id, userId: user.id });
  if (!record) {
    return NextResponse.json({ error: "转录历史不存在。" }, { status: 404 });
  }

  return withUserRouteConcurrency(user.id, "douyin:summarize", async () => {
    return streamHistorySummary({
      historyRecordId: id,
      prompt: parsed.data.prompt,
      promptId: parsed.data.promptId,
      promptTitle: parsed.data.promptTitle,
      transcript: record.transcriptContent,
      userId: user.id,
    });
  });
}

function streamHistorySummary(input: {
  historyRecordId: string;
  prompt: string;
  promptId: string;
  promptTitle: string;
  transcript: string;
  userId: string;
}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: SummaryEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

      try {
        const result = await streamSummarizeTranscript({
          prompt: input.prompt,
          transcript: input.transcript,
          onDelta: (delta) => send({ type: "delta", value: delta }),
        });

        if (result.ok) {
          const summary = await insertTranscriptHistorySummary({
            content: result.content,
            historyRecordId: input.historyRecordId,
            id: createHistorySummaryId(),
            promptId: input.promptId,
            promptTitle: input.promptTitle,
            userId: input.userId,
          });
          send({ summary, type: "done", value: result.content });
        } else {
          send({ type: "error", error: result.detail, code: result.code });
        }
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : "AI处理失败。" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function createHistorySummaryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `summary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
