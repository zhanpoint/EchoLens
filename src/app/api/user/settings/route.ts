import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { rejectDisabledDouyinAccountServices } from "@/app/api/douyin/_account-services";
import { canUseDouyinAccountServices } from "@/lib/douyin/account-services";
import { validateAndStoreDouyinCredential } from "@/lib/douyin/account";
import { BilibiliCredentialError, validateAndStoreBilibiliCredential } from "@/lib/bilibili/account";
import { DouyinApiError } from "@/lib/douyin/web-client";
import {
  BILIBILI_AUDIO_QUALITIES,
  BILIBILI_STREAM_FORMATS,
  BILIBILI_VIDEO_CODECS,
  BILIBILI_VIDEO_QUALITIES,
  DEFAULT_BILIBILI_AUDIO_QUALITY,
  DEFAULT_BILIBILI_STREAM_FORMAT,
  DEFAULT_BILIBILI_VIDEO_QUALITY,
  DEFAULT_DOWNLOAD_ORGANIZATION,
  DEFAULT_DOWNLOAD_VIDEO_QUALITY,
  DOWNLOAD_ORGANIZATIONS,
  DOWNLOAD_VIDEO_QUALITIES,
} from "@/lib/download-settings";
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
const BilibiliSettingsSchema = z.object({
  cookie: z.string().max(120_000),
});
const AiCredentialSettingsSchema = z.object({
  apiKey: z.string().trim().max(256),
}).strict();
const DownloadSettingsSchema = z.object({
  bilibiliAudioQuality: z.enum(BILIBILI_AUDIO_QUALITIES).catch(DEFAULT_BILIBILI_AUDIO_QUALITY),
  bilibiliStreamFormat: z.enum(BILIBILI_STREAM_FORMATS).catch(DEFAULT_BILIBILI_STREAM_FORMAT),
  bilibiliVideoCodec: z.enum(BILIBILI_VIDEO_CODECS).optional(),
  bilibiliVideoQuality: z.enum(BILIBILI_VIDEO_QUALITIES).catch(DEFAULT_BILIBILI_VIDEO_QUALITY),
  directoryPath: z.string().max(500).catch(""),
  organization: z.enum(DOWNLOAD_ORGANIZATIONS).catch(DEFAULT_DOWNLOAD_ORGANIZATION),
  videoQuality: z.enum(DOWNLOAD_VIDEO_QUALITIES).catch(DEFAULT_DOWNLOAD_VIDEO_QUALITY),
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
      includeDouyin: canUseDouyinAccountServices(user),
    })),
  });
}

export async function PUT(request: Request) {
  const parsed = PutSettingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isUserSettingsCategory(parsed.data.category)) {
    return NextResponse.json({ error: "设置参数无效。" }, { status: 400 });
  }

  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  if (parsed.data.category === "douyin") {
    const disabled = rejectDisabledDouyinAccountServices(user);
    if (disabled) return disabled;
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
  } else if (parsed.data.category === "bilibili") {
    try {
      await validateAndStoreBilibiliCredential(user.id, (value.data as z.infer<typeof BilibiliSettingsSchema>).cookie);
    } catch (error) {
      if (error instanceof BilibiliCredentialError) {
        const status = error.code === "UPSTREAM_ERROR" ? 502 : 400;
        return NextResponse.json({ code: error.code, error: error.message }, { status });
      }
      return NextResponse.json({ error: "Bilibili 账号访问凭证验证失败，请稍后重试。" }, { status: 502 });
    }
  } else {
    await upsertUserSetting(user.id, parsed.data.category, value.data);
  }
  return NextResponse.json({
    settings: toPublicSettings(await readUserSettings(user.id, {
      includeDouyin: canUseDouyinAccountServices(user),
    })),
  });
}

function parseSettingsValue(
  category: "aiCredential" | "aiModels" | "bilibili" | "douyin" | "download" | "transcript" | "translation",
  value: unknown,
): { ok: true; data: z.infer<typeof AiCredentialSettingsSchema> | z.infer<typeof BilibiliSettingsSchema> | z.infer<typeof DashScopeModelIdsSchema> | z.infer<typeof DouyinSettingsSchema> | z.infer<typeof DownloadSettingsSchema> | z.infer<typeof TranscriptSettingsSchema> | z.infer<typeof TranslationSettingsSchema> } | { ok: false } {
  if (category === "aiCredential") {
    const parsed = AiCredentialSettingsSchema.safeParse(value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  }
  if (category === "douyin") {
    const parsed = DouyinSettingsSchema.safeParse(value);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  }
  if (category === "bilibili") {
    const parsed = BilibiliSettingsSchema.safeParse(value);
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
