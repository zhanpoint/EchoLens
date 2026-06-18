import { NextResponse } from "next/server";
import { z } from "zod";
import { collectWorkMetadata } from "@/lib/douyin/detail";
import { buildMediaDownloadPath } from "@/lib/douyin/download";
import type { CollectedContent } from "@/lib/douyin/media";
import { DouyinResolveError, resolveDouyinInput } from "@/lib/douyin/url";
import { identifyImageContent, transcribeMedia } from "@/lib/openrouter/provider";
import {
  EXTRACTION_FEATURES,
  FEATURES_BY_KIND,
  getFeatureLabel,
  type DouyinKind,
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
    .max(3),
});

export async function POST(request: Request) {
  const parsed = ExtractSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "请求参数无效，至少选择一个提取功能。" }, { status: 400 });
  }

  try {
    const work = await resolveDouyinInput(parsed.data.input);
    const features = parsed.data.features;
    const allowed = FEATURES_BY_KIND[work.kind];

    if (features.some((feature) => !allowed.includes(feature))) {
      return NextResponse.json({ error: "选择的功能与作品类型不匹配。" }, { status: 400 });
    }

    const metadata = await collectWorkMetadata(work);
    const content: CollectedContent = {
      caption: work.kind === "article" ? metadata?.title : metadata?.caption,
      articleText: metadata?.articleText,
      audioUrls: metadata?.audioUrls ?? [],
      coverUrl: metadata?.coverUrl,
      imageUrls: work.kind === "note" ? metadata?.imageUrls ?? [] : [],
      videoUrl: metadata?.videoUrl,
    };

    const results = await buildResults(features, work, content);

    return NextResponse.json({
      work: {
        ...work,
        authorName: metadata?.authorName,
        authorUrl: metadata?.authorUrl,
      },
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
}

async function buildResults(
  features: ExtractionFeature[],
  work: { id: string; kind: DouyinKind },
  content: CollectedContent,
): Promise<ExtractionResult[]> {
  const results: ExtractionResult[] = [];
  const kind = work.kind;

  for (const feature of features) {
    if (feature === "cover") {
      results.push(coverResult(work, content.coverUrl));
    }

    if (feature === "caption") {
      results.push(
        textResult(feature, kind, content.caption, `没有采集到${getFeatureLabel(feature, kind)}。`),
      );
    }

    if (feature === "articleText") {
      results.push(
        textResult(feature, kind, content.articleText, "没有采集到文章正文。"),
      );
    }

    if (feature === "imageContent") {
      const modelResult = await identifyImageContent(content.imageUrls);
      results.push(providerResult(feature, kind, modelResult));
    }

    if (feature === "transcript") {
      const modelResult = await transcribeMedia(content);
      results.push(providerResult(feature, kind, modelResult));
    }
  }

  return results;
}

function textResult(
  feature: ExtractionFeature,
  kind: DouyinKind,
  content: string | undefined,
  unavailableDetail: string,
): ExtractionResult {
  return content
    ? {
        feature,
        label: getFeatureLabel(feature, kind),
        status: "success",
        source: "detail",
        content,
      }
    : {
        feature,
        label: getFeatureLabel(feature, kind),
        status: "unavailable",
        detail: unavailableDetail,
      };
}

function coverResult(
  work: { id: string; kind: DouyinKind },
  coverUrl: string | undefined,
): ExtractionResult {
  return coverUrl
    ? {
        feature: "cover",
        label: getFeatureLabel("cover", work.kind),
        status: "success",
        source: "detail",
        assets: [
          {
            kind: "cover",
            label: "下载封面",
            previewUrl: buildMediaDownloadPath(work, "cover", { preview: true }),
            url: buildMediaDownloadPath(work, "cover"),
          },
        ],
      }
    : {
        feature: "cover",
        label: getFeatureLabel("cover", work.kind),
        status: "unavailable",
        detail: "没有采集到封面图片。",
      };
}

function providerResult(
  feature: ExtractionFeature,
  kind: DouyinKind,
  result: Awaited<ReturnType<typeof identifyImageContent>>,
): ExtractionResult {
  return result.ok
    ? {
        feature,
        label: getFeatureLabel(feature, kind),
        status: "success",
        source: "openrouter",
        content: result.content,
      }
    : {
        feature,
        label: getFeatureLabel(feature, kind),
        status: result.code,
        detail: result.detail,
      };
}
