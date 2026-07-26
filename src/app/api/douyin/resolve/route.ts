import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { DouyinResolveError, extractFirstUrl, resolveDouyinUrl } from "@/lib/douyin/url";
import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";
import { findOrCreateTranscriptHistoryRecord } from "@/lib/transcript/db";

export const runtime = "nodejs";

const ResolveSchema = z.object({
  currentFinalUrl: z.url().max(2000).optional(),
  currentWorkKey: z.string().min(1).max(256).optional(),
  historyRecordId: z.string().min(1).max(128).optional(),
  input: z.string().min(1).max(5000),
});

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) {
    return user;
  }

  const parsed = ResolveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "请输入抖音分享链接。" }, { status: 400 });
  }

  try {
    const inputUrl = extractFirstUrl(parsed.data.input);
    const resolvedWork = await resolveDouyinUrl(inputUrl);
    const workKey = `${resolvedWork.kind}:${resolvedWork.id}`;
    if (
      parsed.data.currentWorkKey === workKey ||
      (!parsed.data.currentWorkKey && parsed.data.currentFinalUrl === resolvedWork.finalUrl)
    ) {
      return NextResponse.json({ sameAsCurrent: true });
    }

    const metadataLease = await acquireWorkMetadata(resolvedWork);
    try {
      const work = {
        ...resolvedWork,
        authorName: metadataLease.metadata.authorName,
        authorUrl: metadataLease.metadata.authorUrl,
        caption: metadataLease.metadata.caption,
        durationSeconds: metadataLease.metadata.durationSeconds,
      };
      const { created, record: historyRecord } = await findOrCreateTranscriptHistoryRecord({
        authorName: work.authorName,
        authorUrl: work.authorUrl,
        caption: work.caption,
        durationSeconds: work.durationSeconds,
        finalUrl: work.finalUrl,
        id: parsed.data.historyRecordId ?? randomUUID(),
        inputUrl: work.inputUrl,
        transcriptContent: "",
        userId: user.id,
        workId: work.id,
        workKey,
        workKind: work.kind,
      });

      return NextResponse.json({
        historyRecord,
        reusedExistingSession: !created,
        work,
      });
    } finally {
      metadataLease.release();
    }
  } catch (error) {
    if (error instanceof NetworkRetryExhaustedError) {
      return NextResponse.json(
        { code: NETWORK_RETRY_ERROR_CODE, error: NETWORK_RETRY_ERROR_MESSAGE },
        { status: 503 },
      );
    }
    if (error instanceof DouyinResolveError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }

    return NextResponse.json({ error: "识别链接失败。" }, { status: 500 });
  }
}
