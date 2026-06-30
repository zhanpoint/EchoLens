import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { summarizeTranscript } from "@/lib/openrouter/provider";
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
    const result = await summarizeTranscript(parsed.data.text, parsed.data.prompt);
    if (!result.ok) {
      return NextResponse.json({ error: result.detail, code: result.code }, { status: providerErrorStatus(result) });
    }

    return NextResponse.json({ summary: result.content });
  });
}

function providerErrorStatus(result: { code: string; detail: string }): number {
  if (result.code === "not_configured") {
    return 500;
  }
  if (/限流|请求过于频繁|429/.test(result.detail)) {
    return 429;
  }
  if (result.code === "unavailable") {
    return 503;
  }
  return 502;
}
