import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import {
  ApiAccessTokenError,
  deleteApiAccessToken,
  revealApiAccessToken,
  resetApiAccessToken,
  updateApiAccessToken,
} from "@/lib/api-access-tokens/service";

export const runtime = "nodejs";

const ParamsSchema = z.object({ id: z.string().min(1).max(128) });
const UpdateTokenSchema = z.object({
  expiresAt: z.number().finite().optional().nullable(),
  name: z.string().trim().min(1).max(80).optional(),
}).strict();
const ResetTokenSchema = z.object({
  expiresAt: z.number().finite().optional().nullable(),
  reset: z.literal(true),
}).strict();

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const id = await readTokenId(context);
  if (!id) return invalidTokenIdJson();

  return handleApiTokenError(async () => ({ token: await revealApiAccessToken({ id, userId: user.id }) }));
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const id = await readTokenId(context);
  if (!id) return invalidTokenIdJson();

  const body = await request.json().catch(() => null);
  const resetParsed = ResetTokenSchema.safeParse(body);
  if (resetParsed.success) {
    return handleApiTokenError(async () => ({
      ...(await resetApiAccessToken({
        expiresAt: resetParsed.data.expiresAt ?? undefined,
        id,
        userId: user.id,
      })),
    }));
  }

  const parsed = UpdateTokenSchema.safeParse(body);
  if (!parsed.success || (parsed.data.name === undefined && parsed.data.expiresAt === undefined)) {
    return NextResponse.json({ code: "API_TOKEN_INVALID_INPUT", error: "API 访问令牌参数无效。" }, { status: 400 });
  }

  return handleApiTokenError(async () => ({
    token: await updateApiAccessToken({
      expiresAt: parsed.data.expiresAt,
      id,
      name: parsed.data.name,
      userId: user.id,
    }),
  }));
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const id = await readTokenId(context);
  if (!id) return invalidTokenIdJson();

  return handleApiTokenError(async () => {
    await deleteApiAccessToken({ id, userId: user.id });
    return { deleted: true };
  });
}

async function readTokenId(context: RouteContext): Promise<string | null> {
  const parsed = ParamsSchema.safeParse(await context.params);
  return parsed.success ? parsed.data.id : null;
}

function invalidTokenIdJson(): NextResponse {
  return NextResponse.json({ code: "API_TOKEN_INVALID_ID", error: "API 访问令牌不存在。" }, { status: 404 });
}

async function handleApiTokenError<T>(run: () => Promise<T>): Promise<NextResponse> {
  try {
    return NextResponse.json(await run());
  } catch (error) {
    if (error instanceof ApiAccessTokenError) {
      return NextResponse.json({ code: error.code, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ code: "API_TOKEN_OPERATION_FAILED", error: "API 访问令牌操作失败。" }, { status: 500 });
  }
}