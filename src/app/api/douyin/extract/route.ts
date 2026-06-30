import { NextResponse } from "next/server";
import { z } from "zod";
import type { CollectedContent } from "@/lib/douyin/media";
import { DouyinResolveError } from "@/lib/douyin/url";
import { resolveInputWithMetadata } from "@/lib/douyin/work";
import { requireUser } from "@/app/api/auth/_shared";
import { identifyImageContent } from "@/lib/openrouter/provider";
import { withUserRouteConcurrency } from "@/lib/user-concurrency";
import {
  EXTRACTION_FEATURES,
  FEATURES_BY_KIND,
  getFeatureLabel,
  type ExtractionFeature,
  type ExtractionResult,
} from "@/types/douyin";

export const runtime = "nodejs";
export const maxDuration = 120;

const ExtractSchema = z.object({
  input: z.string().min(1).max(5000),
  features: z
    .array(z.enum(EXTRACTION_FEATURES))
    .min(1)
    .max(EXTRACTION_FEATURES.length),
});

export async function POST(request: Request) {
  const user = requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = ExtractSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "请求参数无效，至少选择一个提取功能。" }, { status: 400 });
  }

  return withUserRouteConcurrency(user.id, "douyin:extract", async () => {
    try {
      const resolved = await resolveInputWithMetadata(parsed.data.input);
      const work = resolved.work;
      const features = parsed.data.features;
      const allowed = FEATURES_BY_KIND[work.kind];

      if (features.some((feature) => !allowed.includes(feature))) {
        return NextResponse.json({ error: "选择的功能与作品类型不匹配。" }, { status: 400 });
      }

      const metadata = resolved.metadata;
      const content: CollectedContent = {
        articleText: metadata?.articleText,
        imageUrls: work.kind === "note" ? metadata?.imageUrls ?? [] : [],
      };

      const results = await buildResults(features, content);

      return NextResponse.json({
        work: resolved.work,
        results,
      });
    } catch (error) {
      if (error instanceof DouyinResolveError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
      }

      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "提取失败。",
        },
        { status: 500 },
      );
    }
  });
}

async function buildResults(
  features: ExtractionFeature[],
  content: CollectedContent,
): Promise<ExtractionResult[]> {
  const results: ExtractionResult[] = [];

  for (const feature of features) {
    if (feature === "articleText") {
      results.push(
        textResult(feature, content.articleText, "没有采集到文章正文。"),
      );
    }

    if (feature === "imageContent") {
      const modelResult = await identifyImageContent(content.imageUrls);
      results.push(providerResult(feature, modelResult));
    }

  }

  return results;
}

function textResult(
  feature: ExtractionFeature,
  content: string | undefined,
  unavailableDetail: string,
): ExtractionResult {
  return content
    ? {
        feature,
        label: getFeatureLabel(feature),
        status: "success",
        source: "detail",
        content,
      }
    : {
        feature,
        label: getFeatureLabel(feature),
        status: "unavailable",
        detail: unavailableDetail,
      };
}

function providerResult(
  feature: ExtractionFeature,
  result: Awaited<ReturnType<typeof identifyImageContent>>,
): ExtractionResult {
  return result.ok
    ? {
        feature,
        label: getFeatureLabel(feature),
        status: "success",
        source: "openrouter",
        content: result.content,
        transcriptSegments: result.transcriptSegments,
      }
    : {
        feature,
        label: getFeatureLabel(feature),
        status: result.code,
        detail: result.detail,
      };
}
