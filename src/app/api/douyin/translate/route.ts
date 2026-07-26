import { NextResponse } from "next/server";
import { z } from "zod";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import {
  streamQwenMtText,
  translateQwenMtTextItems,
  type QwenMtTranslationOptions,
} from "@/lib/dashscope/translation";
import { readDashScopeUserConfig } from "@/lib/dashscope/user-credential";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";

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
  | { type: "replace"; key: string; value: "" }
  | { type: "segment_done"; key: string; value: string }
  | { type: "segment_error"; key: string; error: string; code?: string }
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

  const dashScope = await readDashScopeUserConfig(user.id);
  return streamTranslations(
    parsed.data.texts,
    parsed.data.translation_options,
    dashScope.models.translation,
    dashScope.apiKey,
    request.signal,
  );
}

function streamTranslations(
  items: Array<{ key: string; text: string }>,
  options: QwenMtTranslationOptions,
  model: string,
  apiKey?: string,
  signal?: AbortSignal,
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
            apiKey,
            model,
            text: item.text,
            options,
            onDelta: (delta) => send({ type: "delta", key: item.key, value: delta }),
            onReset: () => send({ type: "replace", key: item.key, value: "" }),
            signal,
          });

          if (result.ok) {
            send({ type: "segment_done", key: item.key, value: result.content });
          } else {
            send({ type: "segment_error", key: item.key, error: result.detail, code: result.code });
          }
        } else {
          const results = await translateQwenMtTextItems({ apiKey, items, model, options, signal });
          for (const result of results) {
            if (result.ok) {
              send({ type: "segment_done", key: result.key, value: result.content });
            } else {
              send({ type: "segment_error", key: result.key, error: result.detail, code: result.code });
            }
          }
        }

        send({ type: "done" });
      } catch (error) {
        logServerError("douyin.translate", error);
        const networkFailure = error instanceof NetworkRetryExhaustedError;
        send({
          type: "error",
          error: networkFailure ? NETWORK_RETRY_ERROR_MESSAGE : "翻译失败，请稍后重试。",
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
