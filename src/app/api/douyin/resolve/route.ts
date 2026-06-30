import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { DouyinResolveError } from "@/lib/douyin/url";
import { resolveInputWithMetadata } from "@/lib/douyin/work";
import { withUserRouteConcurrency } from "@/lib/user-concurrency";

export const runtime = "nodejs";

const ResolveSchema = z.object({
  input: z.string().min(1).max(5000),
});

export async function POST(request: Request) {
  const user = requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = ResolveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "请输入抖音分享链接。" }, { status: 400 });
  }

  return withUserRouteConcurrency(user.id, "douyin:resolve", async () => {
    try {
      const resolved = await resolveInputWithMetadata(parsed.data.input, { tolerateMetadataFailure: true });

      return NextResponse.json({
        work: resolved.work,
      });
    } catch (error) {
      if (error instanceof DouyinResolveError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
      }

      return NextResponse.json({ error: "识别链接失败。" }, { status: 500 });
    }
  });
}
