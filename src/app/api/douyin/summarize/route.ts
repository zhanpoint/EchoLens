import { NextResponse } from "next/server";
import { createJsonSseResponse } from "@/lib/http/sse-response";
import { z } from "zod";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import { streamSummarizeTranscript } from "@/lib/dashscope/summary";
import { readDashScopeUserConfig } from "@/lib/dashscope/user-credential";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";
import { insertTranscriptHistorySummary, readTranscriptHistoryRecord, type TranscriptHistorySummary } from "@/lib/transcript/db";

export const runtime = "nodejs";
export const maxDuration = 120;

const SummarySchema = z.object({
  historyRecordId: z.string().min(1).max(128).optional(),
  prompt: z.string().min(1).max(2000),
  promptId: z.string().min(1).max(128).optional(),
  promptTitle: z.string().min(1).max(120).optional(),
  text: z.string().min(1).max(200_000),
});

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = SummarySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "总结参数无效。" }, { status: 400 });
  }

  let transcript = parsed.data.text;
  if (parsed.data.historyRecordId) {
    const record = await readTranscriptHistoryRecord({
      id: parsed.data.historyRecordId,
      userId: user.id,
    });
    if (!record) {
      return NextResponse.json({ error: "转录历史不存在。" }, { status: 404 });
    }
    transcript = record.transcriptContent;
  }

  const dashScope = await readDashScopeUserConfig(user.id);
  return streamSummary({
    apiKey: dashScope.apiKey,
    historyRecordId: parsed.data.historyRecordId,
    prompt: parsed.data.prompt,
    promptId: parsed.data.promptId,
    promptTitle: parsed.data.promptTitle,
    model: dashScope.models.summary,
    transcript,
    userId: user.id,
    signal: request.signal,
  });
}

type SummaryEvent =
  | { type: "delta"; value: string }
  | { type: "replace"; value: "" }
  | { summary?: TranscriptHistorySummary; type: "done"; value: string }
  | { type: "error"; error: string; code?: string };

function streamSummary(input: {
  apiKey?: string;
  historyRecordId?: string;
  model: string;
  prompt: string;
  promptId?: string;
  promptTitle?: string;
  signal?: AbortSignal;
  transcript: string;
  userId: string;
}): Response {
  return createJsonSseResponse<SummaryEvent>(input.signal, async ({ send, signal }) => {
    try {
      const result = await streamSummarizeTranscript({
        apiKey: input.apiKey,
        model: input.model,
        prompt: input.prompt,
        transcript: input.transcript,
        onDelta: (delta) => send({ type: "delta", value: delta }),
        onReset: () => send({ type: "replace", value: "" }),
        signal,
      });
      if (signal.aborted) {
        return;
      }

      if (result.ok) {
        const summary = input.historyRecordId && input.promptId && input.promptTitle
          ? await insertTranscriptHistorySummary({
              content: result.content,
              historyRecordId: input.historyRecordId,
              id: createHistorySummaryId(),
              promptId: input.promptId,
              promptTitle: input.promptTitle,
              userId: input.userId,
            })
          : undefined;
        if (signal.aborted) {
          return;
        }
        send({ summary, type: "done", value: result.content });
      } else {
        send({ type: "error", error: result.detail, code: result.code });
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      logServerError("douyin.summarize", error);
      const networkFailure = error instanceof NetworkRetryExhaustedError;
      send({
        type: "error",
        error: networkFailure ? NETWORK_RETRY_ERROR_MESSAGE : "AI处理失败，请稍后重试。",
        ...(networkFailure ? { code: NETWORK_RETRY_ERROR_CODE } : {}),
      });
    }
  });
}

function createHistorySummaryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `summary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
