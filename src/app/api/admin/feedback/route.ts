import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { isAdminUser } from "@/lib/auth/service";
import {
  FEEDBACK_STATUSES,
  listUserFeedback,
  updateUserFeedbackStatus,
} from "@/lib/feedback/service";

export const runtime = "nodejs";

const FeedbackStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(FEEDBACK_STATUSES),
}).strict();

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;
  if (!isAdminUser(user)) return forbidden();

  const feedback = await listUserFeedback();
  return NextResponse.json(
    { feedback },
    { headers: { "cache-control": "private, no-store" } },
  );
}

export async function PATCH(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;
  if (!isAdminUser(user)) return forbidden();

  const parsed = FeedbackStatusSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ code: "INVALID_FEEDBACK_STATUS", error: "反馈状态参数无效。" }, { status: 400 });
  }

  const feedback = await updateUserFeedbackStatus(parsed.data.id, parsed.data.status);
  if (!feedback) {
    return NextResponse.json({ code: "FEEDBACK_NOT_FOUND", error: "反馈不存在。" }, { status: 404 });
  }
  return NextResponse.json({ feedback });
}

function forbidden() {
  return NextResponse.json({ code: "FORBIDDEN", error: "无权访问。" }, { status: 403 });
}