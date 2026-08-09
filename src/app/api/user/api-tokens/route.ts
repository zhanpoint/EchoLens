import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import {
  ApiAccessTokenError,
  createApiAccessToken,
  listApiAccessTokens,
} from "@/lib/api-access-tokens/service";

export const runtime = "nodejs";

const CreateTokenSchema = z.object({
  expiresAt: z.number().finite().optional().nullable(),
  name: z.string().trim().min(1).max(80),
}).strict();

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  return NextResponse.json({ tokens: await listApiAccessTokens(user.id) });
}

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const parsed = CreateTokenSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ code: "API_TOKEN_INVALID_INPUT", error: "API 访问令牌参数无效。" }, { status: 400 });
  }

  try {
    const created = await createApiAccessToken({
      expiresAt: parsed.data.expiresAt ?? undefined,
      name: parsed.data.name,
      userId: user.id,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof ApiAccessTokenError) {
      return NextResponse.json({ code: error.code, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ code: "API_TOKEN_CREATE_FAILED", error: "API 访问令牌创建失败。" }, { status: 500 });
  }
}