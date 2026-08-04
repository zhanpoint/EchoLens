import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import {
  bilibiliMediaHeaders,
  buildBilibiliWorkId,
  getBilibiliDashSelection,
  type BilibiliWorkMetadata,
} from "@/lib/bilibili/client";
import { downloadBilibiliStream } from "@/lib/bilibili/range-downloader";
import type {
  BilibiliAudioQuality,
  BilibiliStreamFormat,
} from "@/lib/download-settings";
import { createTranscribableAudioFileFromNode } from "@/lib/media/audio";
import { createOssSignedUrl, getOssObjectInfo, putOssStream } from "@/lib/oss/object-store";
import type { PreparedAsset, PreparedAssetKind, StoredAsset } from "@/lib/douyin/asset-bundle";

type OriginalAudioAsset = Extract<PreparedAsset, { asset: "originalAudio" }>["value"];

type BilibiliPersistentAssetKind = Exclude<PreparedAssetKind, "video">;
type BilibiliPersistentAsset = Exclude<PreparedAsset, { asset: "video" }>;

const tasks = new Map<string, Promise<BilibiliPersistentAsset>>();
const REVALIDATED_CACHE_CONTROL = "no-cache";

export async function ensureBilibiliAsset(input: {
  assetKind: BilibiliPersistentAssetKind;
  cookie?: string;
  metadata: BilibiliWorkMetadata;
  audioQuality?: BilibiliAudioQuality;
  streamFormat?: BilibiliStreamFormat;
}): Promise<BilibiliPersistentAsset> {
  const workId = buildBilibiliWorkId(input.metadata.bvid, input.metadata.cid);
  const key = [
    workId,
    input.assetKind,
    input.audioQuality ?? "lowest",
    input.streamFormat ?? "dashFull",
  ].join(":");
  const existing = tasks.get(key);
  if (existing) return existing;
  const task = prepareBilibiliAsset(input).finally(() => {
    if (tasks.get(key) === task) tasks.delete(key);
  });
  tasks.set(key, task);
  return task;
}

export function bilibiliAssetUrl(asset: StoredAsset): string {
  return createOssSignedUrl(asset.objectKey);
}

async function prepareBilibiliAsset(input: Parameters<typeof ensureBilibiliAsset>[0]): Promise<PreparedAsset> {
  const prefix = `echolens/media/bilibili/video/${encodeURIComponent(buildBilibiliWorkId(input.metadata.bvid, input.metadata.cid))}/`;
  if (input.assetKind === "avatar") {
    return { asset: "avatar", value: await ensureImage(`${prefix}avatar`, input.metadata.authorAvatarUrls) };
  }
  if (input.assetKind === "cover") {
    return { asset: "cover", value: await ensureImage(`${prefix}cover`, input.metadata.coverUrls) };
  }
  return {
    asset: "originalAudio",
    value: await ensureAudio(`${prefix}audio.m4a`, input),
  };
}

async function ensureImage(objectKey: string, urls: readonly string[]): Promise<StoredAsset> {
  const cached = await getOssObjectInfo(objectKey);
  if (cached) return fromOssInfo(objectKey, cached, "image/jpeg");
  const url = urls[0];
  if (!url) throw new Error("Bilibili 图片地址不可用。");
  const response = await fetch(url, { headers: bilibiliMediaHeaders() });
  if (!response.ok || !response.body) throw new Error(`Bilibili 图片下载失败：HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const body = new Uint8Array(await response.arrayBuffer());
  try {
    await putOssStream({
      body: Readable.toWeb(Readable.from([body])) as ReadableStream<Uint8Array>,
      cacheControl: "public, max-age=86400, immutable",
      contentLength: body.byteLength,
      contentType,
      objectKey,
    });
    return { contentType, objectKey, sizeBytes: body.byteLength };
  } finally {
    body.fill(0);
  }
}

async function ensureAudio(
  objectKey: string,
  input: Parameters<typeof ensureBilibiliAsset>[0],
): Promise<OriginalAudioAsset> {
  const cached = await getOssObjectInfo(objectKey);
  if (cached) {
    return {
      ...fromOssInfo(objectKey, cached, "audio/mp4"),
      durationSeconds: input.metadata.durationSeconds,
    };
  }

  const selection = await getBilibiliDashSelection({
    bvid: input.metadata.bvid,
    cid: input.metadata.cid,
    audioQuality: input.audioQuality,
    cookie: input.cookie,
    streamFormat: input.streamFormat,
  });
  const downloaded = await downloadBilibiliStream({
    headers: bilibiliMediaHeaders(input.cookie),
    name: "audio.m4s",
    urls: selection.audio.urls,
  });
  try {
    const audio = await createTranscribableAudioFileFromNode(createReadStream(downloaded.filePath));
    try {
      await uploadFile(audio.filePath, objectKey, audio.contentType, audio.sizeBytes);
      return {
        contentType: audio.contentType,
        durationSeconds: input.metadata.durationSeconds || audio.durationSeconds,
        objectKey,
        sizeBytes: audio.sizeBytes,
      };
    } finally {
      await audio.cleanup();
    }
  } finally {
    await downloaded.cleanup();
  }
}

async function uploadFile(
  filePath: string,
  objectKey: string,
  contentType: string,
  contentLength: number,
): Promise<void> {
  await putOssStream({
    body: Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>,
    cacheControl: REVALIDATED_CACHE_CONTROL,
    contentLength,
    contentType,
    objectKey,
  });
}

function fromOssInfo(
  objectKey: string,
  info: { contentLength: number; contentType: string },
  fallback: string,
): StoredAsset {
  return {
    contentType: info.contentType || fallback,
    objectKey,
    sizeBytes: info.contentLength,
  };
}
