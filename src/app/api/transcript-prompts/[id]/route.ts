import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import {
  deleteTranscriptCustomPrompt,
  type TranscriptCustomPrompt,
  updateTranscriptCustomPrompt,
} from "@/lib/transcript/db";

export const runtime = "nodejs";

const CustomPromptSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  title: z.string().trim().min(1).max(120),
}).strict();

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: Request, context: RouteContext) {
  const user = requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = CustomPromptSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "自定义提示词参数无效。" }, { status: 400 });
  }

  const { id } = await context.params;
  const prompt = updateTranscriptCustomPrompt({
    id,
    prompt: parsed.data.prompt,
    title: parsed.data.title,
    userId: user.id,
  });
  if (!prompt) {
    return NextResponse.json({ error: "自定义提示词不存在。" }, { status: 404 });
  }

  return NextResponse.json({ prompt: serializeCustomPrompt(prompt) });
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const { id } = await context.params;
  if (!deleteTranscriptCustomPrompt({ id, userId: user.id })) {
    return NextResponse.json({ error: "自定义提示词不存在。" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

function serializeCustomPrompt(prompt: TranscriptCustomPrompt) {
  return {
    createdAt: prompt.createdAt,
    description: prompt.description,
    id: prompt.id,
    prompt: prompt.prompt,
    title: prompt.title,
    updatedAt: prompt.updatedAt,
  };
}
