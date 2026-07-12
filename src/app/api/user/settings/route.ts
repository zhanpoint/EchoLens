import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { validateAndStoreDouyinCredential } from "@/lib/douyin/account";
import { DouyinApiError } from "@/lib/douyin/web-client";
import { isUserSettingsCategory, readUserSettings, upsertUserSetting } from "@/lib/user-settings";

export const runtime = "nodejs";

const TranslationSettingsSchema = z.object({
  domains: z.string().max(2000).catch(""),
  showSource: z.boolean().catch(true),
  targetLang: z.string().max(80).catch(""),
  termsText: z.string().max(16_000).catch(""),
  tmText: z.string().max(16_000).catch(""),
});
const TranscriptSettingsSchema = z.object({
  includeSpeakerEmotion: z.boolean().catch(false),
  showSpeaker: z.boolean().catch(true),
  showSpeakerEmotion: z.boolean().catch(false),
});
const DouyinSettingsSchema = z.object({
  cookie: z.string().max(120_000),
});

const PutSettingsSchema = z.object({
  category: z.string().trim().min(1).max(80),
  value: z.unknown(),
});

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  return NextResponse.json({ settings: await readUserSettings(user.id) });
}

export async function PUT(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = PutSettingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isUserSettingsCategory(parsed.data.category)) {
    return NextResponse.json({ error: "设置参数无效。" }, { status: 400 });
  }

  const value = parseSettingsValue(parsed.data.category, parsed.data.value);
  if (!value.ok) {
    return NextResponse.json({ error: "设置内容无效。" }, { status: 400 });
  }

  if (parsed.data.category === "douyin") {
    try {
      await validateAndStoreDouyinCredential(user.id, (value.data as z.infer<typeof DouyinSettingsSchema>).cookie);
    } catch (error) {
      if (error instanceof DouyinApiError) {
        const status = error.code === "UPSTREAM_ERROR" ? 502 : 400;
        return NextResponse.json({ code: error.code, error: error.message }, { status });
      }
      return NextResponse.json({ error: "抖音账号访问凭证验证失败，请稍后重试。" }, { status: 502 });
    }
  } else {
    await upsertUserSetting(user.id, parsed.data.category, value.data);
  }
  return NextResponse.json({ settings: await readUserSettings(user.id) });
}

function parseSettingsValue(
  category: "douyin" | "transcript" | "translation",
  value: unknown,
): { ok: true; data: z.infer<typeof DouyinSettingsSchema> | z.infer<typeof TranscriptSettingsSchema> | z.infer<typeof TranslationSettingsSchema> } | { ok: false } {
  if (category === "douyin") {
    const parsed = DouyinSettingsSchema.safeParse(value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  }
  if (category === "transcript") {
    const parsed = TranscriptSettingsSchema.safeParse(value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  }
  if (category === "translation") {
    const parsed = TranslationSettingsSchema.safeParse(value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  }
  return { ok: false };
}
