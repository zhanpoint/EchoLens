import {
  BilibiliApiError,
  getBilibiliDashSelection,
  isBilibiliBvid,
  resolveBilibiliWork,
} from "@/lib/bilibili/client";
import { acquireWorkMetadata } from "@/lib/douyin/metadata-coordinator";
import { DouyinResolveError, resolveDouyinUrl } from "@/lib/douyin/url";
import { MediaRedirectError, resolveMediaUrl } from "@/lib/media/redirect";
import { ensureOpenAudioCache } from "@/lib/open-api/audio-cache";
import {
  openApiPlatformRequestPolicy,
  type OpenApiPlatformRequestPolicy,
} from "@/lib/open-api/platform-request-policy";

export { BilibiliApiError, DouyinResolveError, MediaRedirectError };

export type OpenMediaResource = {
  author: {
    avatarUrl: string;
    name: string;
  };
  coverUrl: string;
  downloads: {
    audioUrl: string;
    videoUrl: string;
  };
  source: "bilibili" | "douyin";
  title: string;
};

export type OpenTranscriptionMedia = {
  audioUrl: string;
  durationSeconds: number;
  resource: OpenMediaResource;
  title: string;
};

export async function resolveOpenMediaResources(input: {
  inputs: string[];
  userId: string;
}): Promise<OpenMediaResource[]> {
  return await Promise.all(input.inputs.map(async (value) => (
    await resolveOpenMedia({ input: value, userId: input.userId })
  ).resource));
}

export async function resolveOpenTranscriptionMedia(input: {
  input: string;
  userId: string;
}): Promise<OpenTranscriptionMedia> {
  return await resolveOpenMedia(input);
}

async function resolveOpenMedia(input: {
  input: string;
  userId: string;
}): Promise<OpenTranscriptionMedia> {
  const requestPolicy = openApiPlatformRequestPolicy.forUser(input.userId);
  if (isBilibiliBvid(input.input)) return await resolveBilibiliMedia(input, requestPolicy);

  const media = await resolveMediaUrl(input.input);
  if (media.source === "douyin") {
    return await resolveDouyinMedia(
      { finalUrl: media.finalUrl, inputUrl: media.inputUrl },
      requestPolicy,
    );
  }
  return await resolveBilibiliMedia({ input: media.inputUrl, finalUrl: media.finalUrl }, requestPolicy);
}

async function resolveDouyinMedia(
  input: { finalUrl: string; inputUrl: string },
  requestPolicy: OpenApiPlatformRequestPolicy,
): Promise<OpenTranscriptionMedia> {
  const work = await resolveDouyinUrl(input.inputUrl, { finalUrl: input.finalUrl });
  const lease = await acquireWorkMetadata(work, undefined, requestPolicy);
  try {
    const metadata = lease.metadata;
    const videoUrl = requiredUrl(metadata.videoUrls[0], "抖音视频下载地址");
    const audio = await ensureOpenAudioCache({
      durationSeconds: metadata.durationSeconds,
      mediaId: work.id,
      mediaSource: "douyin",
      sources: metadata.videoUrls,
    });
    return {
      audioUrl: audio.url,
      durationSeconds: audio.durationSeconds || metadata.durationSeconds,
      resource: {
        author: {
          avatarUrl: requiredUrl(metadata.authorAvatarUrls[0], "抖音作者头像地址"),
          name: metadata.authorName,
        },
        coverUrl: requiredUrl(metadata.coverUrls[0], "抖音视频封面地址"),
        downloads: { audioUrl: audio.url, videoUrl },
        source: "douyin",
        title: metadata.caption,
      },
      title: metadata.caption,
    };
  } finally {
    lease.release();
  }
}

async function resolveBilibiliMedia(
  input: {
    finalUrl?: string;
    input: string;
  },
  requestPolicy: OpenApiPlatformRequestPolicy,
): Promise<OpenTranscriptionMedia> {
  const { metadata } = await resolveBilibiliWork(
    input.input,
    "",
    input.finalUrl ? { finalUrl: input.finalUrl, requestPolicy } : { requestPolicy },
  );
  const selection = await getBilibiliDashSelection({
    bvid: metadata.bvid,
    cid: metadata.cid,
    requestPolicy,
  });
  const audioUrl = requiredUrl(selection.audio.urls[0], "Bilibili 音频下载地址");
  const audio = await ensureOpenAudioCache({
    durationSeconds: metadata.durationSeconds,
    mediaId: metadata.bvid,
    mediaSource: "bilibili",
    sources: [audioUrl],
  });
  return {
    audioUrl: audio.url,
    durationSeconds: audio.durationSeconds || metadata.durationSeconds,
    resource: {
      author: {
        avatarUrl: requiredUrl(metadata.authorAvatarUrls[0], "Bilibili 作者头像地址"),
        name: metadata.authorName,
      },
      coverUrl: requiredUrl(metadata.coverUrls[0], "Bilibili 视频封面地址"),
      downloads: {
        audioUrl: audio.url,
        videoUrl: requiredUrl(selection.video.urls[0], "Bilibili 视频下载地址"),
      },
      source: "bilibili",
      title: metadata.caption,
    },
    title: metadata.caption,
  };
}

function requiredUrl(value: string | undefined, label: string): string {
  if (value) return value;
  throw new Error(`${label}不可用。`);
}