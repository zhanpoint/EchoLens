import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import {
  insertTranscriptCustomPrompt,
  listTranscriptCustomPrompts,
  type TranscriptCustomPrompt,
} from "@/lib/transcript/db";

export const runtime = "nodejs";

const CustomPromptSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  title: z.string().trim().min(1).max(120),
}).strict();

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  return NextResponse.json({
    prompts: (await listTranscriptCustomPrompts({ userId: user.id })).map(serializeCustomPrompt),
  });
}

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = CustomPromptSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "自定义提示词参数无效。" }, { status: 400 });
  }

  const prompt = await insertTranscriptCustomPrompt({
    id: createCustomPromptId(),
    prompt: parsed.data.prompt,
    title: parsed.data.title,
    userId: user.id,
  });

  return NextResponse.json({ prompt: serializeCustomPrompt(prompt) }, { status: 201 });
}

function createCustomPromptId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
