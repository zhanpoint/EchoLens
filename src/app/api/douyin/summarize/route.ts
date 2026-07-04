import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { streamSummarizeTranscript } from "@/lib/openrouter/provider";
import { withUserRouteConcurrency } from "@/lib/user-concurrency";

export const runtime = "nodejs";
export const maxDuration = 120;

const SummarySchema = z.object({
  prompt: z.string().min(1).max(2000),
  text: z.string().min(1).max(200_000),
});

export async function POST(request: Request) {
  const user = requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = SummarySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "总结参数无效。" }, { status: 400 });
  }

  return withUserRouteConcurrency(user.id, "douyin:summarize", async () => {
    return streamSummary(parsed.data.text, parsed.data.prompt);
  });
}

type SummaryEvent =
  | { type: "delta"; value: string }
  | { type: "done"; value: string }
  | { type: "error"; error: string; code?: string };

function streamSummary(transcript: string, prompt: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: SummaryEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

      try {
        const result = await streamSummarizeTranscript({
          prompt,
          transcript,
          onDelta: (delta) => send({ type: "delta", value: delta }),
        });

        if (result.ok) {
          send({ type: "done", value: result.content });
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
