import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { summarizeTranscript } from "@/lib/openrouter/provider";
import { withUserRouteConcurrency } from "@/lib/user-concurrency";
import { withUserRateLimit } from "@/lib/user-rate-limit";

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

  return withUserRateLimit(user.id, "douyin:summarize", async () => {
    const parsed = SummarySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "总结参数无效。" }, { status: 400 });
    }

    return withUserRouteConcurrency(user.id, "douyin:summarize", async () => {
      const result = await summarizeTranscript(parsed.data.text, parsed.data.prompt);
      if (!result.ok) {
        return NextResponse.json({ error: result.detail, code: result.code }, { status: 502 });
      }

      return NextResponse.json({ summary: result.content });
    });
  });
}
