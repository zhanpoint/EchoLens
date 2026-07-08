import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import {
  streamQwenMtText,
  translateQwenMtTextItems,
  type QwenMtTranslationOptions,
} from "@/lib/dashscope/translation";

export const runtime = "nodejs";
export const maxDuration = 120;

const TranslationPairSchema = z.object({
  source: z.string().trim().min(1).max(500),
  target: z.string().trim().min(1).max(500),
});

const TranslationOptionsSchema = z.object({
  domains: z.string().trim().max(2000).optional(),
  source_lang: z.literal("auto").default("auto"),
  target_lang: z.string().trim().min(1).max(80),
  terms: z.array(TranslationPairSchema).max(80).optional(),
  tm_list: z.array(TranslationPairSchema).max(40).optional(),
});

const TimedTextSchema = z.object({
  key: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(24_000),
});

const TranslateSchema = z.object({
  texts: z.array(TimedTextSchema).min(1).max(500),
  translation_options: TranslationOptionsSchema,
});

type TranslateEvent =
  | { type: "segment_start"; key: string }
  | { type: "delta"; key: string; value: string }
  | { type: "segment_done"; key: string; value: string }
  | { type: "segment_error"; key: string; error: string }
  | { type: "done" }
  | { type: "error"; error: string; code?: string };

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = TranslateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "翻译参数无效。" }, { status: 400 });
  }

  return streamTranslations(parsed.data.texts, parsed.data.translation_options);
}

function streamTranslations(
  items: Array<{ key: string; text: string }>,
  options: QwenMtTranslationOptions,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: TranslateEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

      try {
        for (const item of items) {
          send({ type: "segment_start", key: item.key });
        }

        if (items.length === 1) {
          const item = items[0];
          const result = await streamQwenMtText({
            text: item.text,
            options,
            onDelta: (delta) => send({ type: "delta", key: item.key, value: delta }),
          });

          if (result.ok) {
            send({ type: "segment_done", key: item.key, value: result.content });
          } else {
            send({ type: "segment_error", key: item.key, error: result.detail });
          }
        } else {
          const results = await translateQwenMtTextItems({ items, options });
          for (const result of results) {
            if (result.ok) {
              send({ type: "segment_done", key: result.key, value: result.content });
            } else {
              send({ type: "segment_error", key: result.key, error: result.detail });
            }
          }
        }

        send({ type: "done" });
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : "翻译失败。" });
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
