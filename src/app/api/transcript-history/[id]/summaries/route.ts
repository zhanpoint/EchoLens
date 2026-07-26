import { NextResponse } from "next/server";
import { z } from "zod";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import { streamSummarizeTranscript } from "@/lib/dashscope/summary";
import { readDashScopeUserConfig } from "@/lib/dashscope/user-credential";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";
import {
  deleteTranscriptHistorySummary,
  insertTranscriptHistorySummary,
  readTranscriptHistoryRecord,
  type TranscriptHistorySummary,
} from "@/lib/transcript/db";

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
  | { type: "replace"; value: "" }
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

  const dashScope = await readDashScopeUserConfig(user.id);
  return streamHistorySummary({
    apiKey: dashScope.apiKey,
    historyRecordId: id,
    prompt: parsed.data.prompt,
    promptId: parsed.data.promptId,
    promptTitle: parsed.data.promptTitle,
    model: dashScope.models.summary,
    transcript: record.transcriptContent,
    userId: user.id,
    signal: request.signal,
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const { id } = await context.params;
  const summaryId = new URL(request.url).searchParams.get("summaryId")?.trim();
  if (!summaryId) {
    return NextResponse.json({ error: "总结记录无效。" }, { status: 400 });
  }

  const deleted = await deleteTranscriptHistorySummary({
    historyRecordId: id,
    id: summaryId,
    userId: user.id,
  });
  if (!deleted) {
    return NextResponse.json({ error: "总结记录不存在。" }, { status: 404 });
  }

  return NextResponse.json({ deleted: true });
}

function streamHistorySummary(input: {
  apiKey?: string;
  historyRecordId: string;
  model: string;
  prompt: string;
  promptId: string;
  promptTitle: string;
  transcript: string;
  userId: string;
  signal?: AbortSignal;
}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: SummaryEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

      try {
        const result = await streamSummarizeTranscript({
          apiKey: input.apiKey,
          model: input.model,
          prompt: input.prompt,
          transcript: input.transcript,
          onDelta: (delta) => send({ type: "delta", value: delta }),
          onReset: () => send({ type: "replace", value: "" }),
          signal: input.signal,
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
        logServerError("transcript.summary", error);
        const networkFailure = error instanceof NetworkRetryExhaustedError;
        send({
          type: "error",
          error: networkFailure ? NETWORK_RETRY_ERROR_MESSAGE : "AI处理失败，请稍后重试。",
          ...(networkFailure ? { code: NETWORK_RETRY_ERROR_CODE } : {}),
        });
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
