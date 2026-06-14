import { NextResponse } from "next/server";
import { z } from "zod";
import { collectWorkMetadata } from "@/lib/douyin/detail";
import { DouyinResolveError, resolveDouyinInput } from "@/lib/douyin/url";

export const runtime = "nodejs";

const ResolveSchema = z.object({
  input: z.string().min(1).max(5000),
});

export async function POST(request: Request) {
  const parsed = ResolveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "请输入抖音分享链接。" }, { status: 400 });
  }

  try {
    const work = await resolveDouyinInput(parsed.data.input);
    const metadata = await collectWorkMetadata(work).catch(() => null);

    return NextResponse.json({
      work: {
        ...work,
        authorName: metadata?.authorName,
        authorUrl: metadata?.authorUrl,
      },
    });
  } catch (error) {
    if (error instanceof DouyinResolveError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }

    return NextResponse.json({ error: "识别链接失败。" }, { status: 500 });
  }
}
