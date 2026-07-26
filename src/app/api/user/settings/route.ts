import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { rejectDisabledDouyinAccountServices } from "@/app/api/douyin/_account-services";
import { isDouyinAccountServicesEnabled } from "@/lib/douyin/account-services";
import { validateAndStoreDouyinCredential } from "@/lib/douyin/account";
import { DouyinApiError } from "@/lib/douyin/web-client";
import { DEFAULT_DOWNLOAD_ORGANIZATION, DOWNLOAD_ORGANIZATIONS } from "@/lib/download-settings";
import { normalizeDashScopeModelIds } from "@/lib/dashscope/model-config";
import { DashScopeModelIdsSchema } from "@/lib/dashscope/model-schema";
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
const AiCredentialSettingsSchema = z.object({
  apiKey: z.string().trim().max(256),
}).strict();
const DownloadSettingsSchema = z.object({
  directoryPath: z.string().max(500).catch(""),
  organization: z.enum(DOWNLOAD_ORGANIZATIONS).catch(DEFAULT_DOWNLOAD_ORGANIZATION),
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

  return NextResponse.json({
    settings: toPublicSettings(await readUserSettings(user.id, {
      includeDouyin: isDouyinAccountServicesEnabled(),
    })),
  });
}

export async function PUT(request: Request) {
  const parsed = PutSettingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isUserSettingsCategory(parsed.data.category)) {
    return NextResponse.json({ error: "设置参数无效。" }, { status: 400 });
  }

  if (parsed.data.category === "douyin") {
    const disabled = rejectDisabledDouyinAccountServices();
    if (disabled) return disabled;
  }

  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
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
  return NextResponse.json({
    settings: toPublicSettings(await readUserSettings(user.id, {
      includeDouyin: isDouyinAccountServicesEnabled(),
    })),
  });
}

function parseSettingsValue(
  category: "aiCredential" | "aiModels" | "douyin" | "download" | "transcript" | "translation",
  value: unknown,
): { ok: true; data: z.infer<typeof AiCredentialSettingsSchema> | z.infer<typeof DashScopeModelIdsSchema> | z.infer<typeof DouyinSettingsSchema> | z.infer<typeof DownloadSettingsSchema> | z.infer<typeof TranscriptSettingsSchema> | z.infer<typeof TranslationSettingsSchema> } | { ok: false } {
  if (category === "aiCredential") {
    const parsed = AiCredentialSettingsSchema.safeParse(value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  }
  if (category === "douyin") {
    const parsed = DouyinSettingsSchema.safeParse(value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  }
  if (category === "aiModels") {
    const parsed = DashScopeModelIdsSchema.safeParse(value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  }
  if (category === "transcript") {
    const parsed = TranscriptSettingsSchema.safeParse(value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  }
  if (category === "download") {
    const parsed = DownloadSettingsSchema.safeParse(value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  }
  if (category === "translation") {
    const parsed = TranslationSettingsSchema.safeParse(value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  }
  return { ok: false };
}

function toPublicSettings(settings: Awaited<ReturnType<typeof readUserSettings>>) {
  const aiCredential = settings.aiCredential as { apiKey?: unknown } | undefined;
  return {
    ...settings,
    aiModels: normalizeDashScopeModelIds(settings.aiModels),
    ...(aiCredential ? { aiCredential: { configured: typeof aiCredential.apiKey === "string" && Boolean(aiCredential.apiKey) } } : {}),
  };
}
