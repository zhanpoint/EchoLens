import { NextResponse } from "next/server";
import { z } from "zod";
import { logServerError, requireUser } from "@/app/api/auth/_shared";
import { testDashScopeCredential } from "@/lib/dashscope/credential-test";
import { DashScopeModelIdsSchema } from "@/lib/dashscope/model-schema";
import { readDashScopeUserConfig } from "@/lib/dashscope/user-credential";

export const runtime = "nodejs";
export const maxDuration = 120;

const MODEL_PURPOSES = ["asrE1", "asrE2", "asrE3", "translation", "transcriptPostprocess", "summary"] as const;

const TestCredentialSchema = z.object({
  apiKey: z.string().trim().max(256).optional(),
  models: DashScopeModelIdsSchema.optional(),
  purpose: z.enum(MODEL_PURPOSES).optional(),
}).strict();

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = TestCredentialSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "API Key 测试参数无效。" }, { status: 400 });
  }

  const dashScope = await readDashScopeUserConfig(user.id);
  const apiKey = parsed.data.apiKey || dashScope.apiKey;
  if (!apiKey) {
    return NextResponse.json({ error: "请先输入 API Key。" }, { status: 400 });
  }

  try {
    const models = (parsed.data.apiKey || dashScope.isCustomApiKey) && parsed.data.models
      ? parsed.data.models
      : dashScope.models;
    const result = await testDashScopeCredential(apiKey, models, parsed.data.purpose);
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error) {
    logServerError("user.ai-credential.test", error);
    return NextResponse.json({
      error: "API Key 测试失败，请稍后重试。",
    }, { status: 502 });
  }
}
