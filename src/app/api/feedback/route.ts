import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { createUserFeedback, FEEDBACK_TYPES } from "@/lib/feedback/service";

export const runtime = "nodejs";

const FeedbackSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  type: z.enum(FEEDBACK_TYPES).nullable().optional(),
}).strict();

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const parsed = FeedbackSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ code: "INVALID_FEEDBACK", error: "反馈内容无效。" }, { status: 400 });
  }

  const feedback = await createUserFeedback({
    content: parsed.data.content,
    type: parsed.data.type ?? null,
    userId: user.id,
  });
  return NextResponse.json({ feedback }, { status: 201 });
}