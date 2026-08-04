import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/app/api/auth/_shared";
import { readUsableBilibiliCookie } from "@/lib/bilibili/account";
import {
  BilibiliApiError,
  isBilibiliBvid,
  resolveBilibiliWork,
  type BilibiliResolvedWork,
} from "@/lib/bilibili/client";
import {
  DouyinResolveError,
  resolveDouyinUrl,
} from "@/lib/douyin/url";
import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";
import {
  MediaRedirectError,
  resolveMediaUrl,
} from "@/lib/media/redirect";
import { buildWorkKey } from "@/lib/media/source";
import { findOrCreateTranscriptHistoryRecord } from "@/lib/transcript/db";
import type { DouyinWorkIdentity, ResolvedDouyinWork } from "@/types/douyin";
import { readUserSetting } from "@/lib/user-settings";
import {
  NETWORK_RETRY_ERROR_CODE,
  NETWORK_RETRY_ERROR_MESSAGE,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";

export const runtime = "nodejs";

const ResolveSchema = z.object({
  currentFinalUrl: z.url().max(2_000).optional(),
  currentWorkKey: z.string().min(1).max(256).optional(),
  historyRecordId: z.string().min(1).max(128).optional(),
  input: z.string().min(1).max(5_000),
});

type ResolvedMediaWork = ResolvedDouyinWork | BilibiliResolvedWork;

const INVALID_MEDIA_LINK_MESSAGE = "该抖音或 Bilibili 视频链接已失效或无法访问，请确认后重新输入。";

class InvalidMediaLinkError extends Error {}

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof NextResponse) return user;

  const parsed = ResolveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "请输入抖音或 Bilibili 作品分享链接。" }, { status: 400 });
  }

  try {
    if (isBilibiliBvid(parsed.data.input)) {
      return await resolveAndPersistBilibili({
        currentFinalUrl: parsed.data.currentFinalUrl,
        currentWorkKey: parsed.data.currentWorkKey,
        historyRecordId: parsed.data.historyRecordId,
        input: parsed.data.input,
        userId: user.id,
      });
    }

    const media = await resolveMediaUrl(parsed.data.input);
    if (media.source === "douyin") {
      const resolvedWork = await resolveDouyinUrl(media.inputUrl, { finalUrl: media.finalUrl });
      const workKey = buildWorkKey(resolvedWork);
      if (isSameCurrent(parsed.data, workKey, resolvedWork.finalUrl)) {
        return NextResponse.json({ sameAsCurrent: true });
      }

      const work = await enrichDouyinWork(resolvedWork);
      return await persistWork({
        historyRecordId: parsed.data.historyRecordId,
        userId: user.id,
        work,
      });
    }

    return resolveAndPersistBilibili({
      currentFinalUrl: parsed.data.currentFinalUrl,
      currentWorkKey: parsed.data.currentWorkKey,
      finalUrl: media.finalUrl,
      historyRecordId: parsed.data.historyRecordId,
      input: media.inputUrl,
      userId: user.id,
    });
  } catch (error) {
    if (error instanceof NetworkRetryExhaustedError) {
      return NextResponse.json(
        { code: NETWORK_RETRY_ERROR_CODE, error: NETWORK_RETRY_ERROR_MESSAGE },
        { status: 503 },
      );
    }
    if (error instanceof MediaRedirectError) {
      return NextResponse.json(
        { code: error.code, error: error.message },
        { status: error.code === "network_error" ? 503 : 400 },
      );
    }
    if (
      error instanceof InvalidMediaLinkError ||
      error instanceof DouyinResolveError ||
      error instanceof BilibiliApiError
    ) {
      return NextResponse.json(
        { code: "invalid_media_link", error: INVALID_MEDIA_LINK_MESSAGE },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: "识别作品链接失败，请稍后重试。" }, { status: 502 });
  }
}

async function resolveAndPersistBilibili(input: {
  currentFinalUrl?: string;
  currentWorkKey?: string;
  finalUrl?: string;
  historyRecordId?: string;
  input: string;
  userId: string;
}) {
  const settings = await readUserSetting(input.userId, "bilibili");
  const { work } = await resolveBilibiliWork(
    input.input,
    readUsableBilibiliCookie(settings),
    input.finalUrl ? { finalUrl: input.finalUrl } : {},
  );
  const workKey = buildWorkKey(work);
  if (isSameCurrent(input, workKey, work.finalUrl)) {
    return NextResponse.json({ sameAsCurrent: true });
  }
  return persistWork({
    historyRecordId: input.historyRecordId,
    userId: input.userId,
    work,
  });
}

async function enrichDouyinWork(work: DouyinWorkIdentity): Promise<ResolvedDouyinWork> {
  let metadataLease: Awaited<ReturnType<typeof acquireWorkMetadata>>;
  try {
    metadataLease = await acquireWorkMetadata(work);
  } catch (error) {
    if (error instanceof NetworkRetryExhaustedError) throw error;
    throw new InvalidMediaLinkError(INVALID_MEDIA_LINK_MESSAGE);
  }

  try {
    return {
      ...work,
      authorName: metadataLease.metadata.authorName,
      authorUrl: metadataLease.metadata.authorUrl,
      caption: metadataLease.metadata.caption,
      durationSeconds: metadataLease.metadata.durationSeconds,
    };
  } finally {
    metadataLease.release();
  }
}

function isSameCurrent(
  input: Pick<z.infer<typeof ResolveSchema>, "currentFinalUrl" | "currentWorkKey">,
  workKey: string,
  finalUrl: string,
): boolean {
  return input.currentWorkKey === workKey || (!input.currentWorkKey && input.currentFinalUrl === finalUrl);
}

async function persistWork(input: {
  historyRecordId?: string;
  userId: string;
  work: ResolvedMediaWork;
}) {
  const workKey = buildWorkKey(input.work);
  const { created, record: historyRecord } = await findOrCreateTranscriptHistoryRecord({
    authorName: input.work.authorName,
    authorUrl: input.work.authorUrl,
    caption: input.work.caption,
    durationSeconds: input.work.durationSeconds,
    finalUrl: input.work.finalUrl,
    id: input.historyRecordId ?? randomUUID(),
    inputUrl: input.work.inputUrl,
    transcriptContent: "",
    userId: input.userId,
    workId: input.work.id,
    workKey,
    workKind: input.work.kind,
  });
  return NextResponse.json({
    historyRecord,
    reusedExistingSession: !created,
    work: input.work,
  });
}
