import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { buildAuthorUrl, collectWorkMetadata, parseWorkMetadata } from "../lib/douyin/detail";
import { estimateMediaProcessingDurationSeconds } from "../lib/douyin/cache-estimate";
import {
  createTranscribableAudioFileFromNode,
  probeTranscribableAudioFromUrl,
  resolveBundledFfmpegPath,
  resolveFfmpegPath,
} from "../lib/media/audio";
import { classifyDouyinUrl, extractFirstUrl, resolveDouyinInput } from "../lib/douyin/url";
import { getFeatureLabel } from "../types/douyin";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DOUYIN_COOKIE;
  delete process.env.DOUYIN_USER_AGENT;
  delete process.env.FFMPEG_PATH;
});

function sharePageHtml(videoInfoRes: unknown): string {
  return `<html><body><script>window._ROUTER_DATA = ${JSON.stringify({
    loaderData: {
      "video_(id)/page": {
        videoInfoRes,
      },
    },
  })}</script></body></html>`;
}

describe("douyin url utilities", () => {
  it("extracts the first url from shared text", () => {
    expect(extractFirstUrl("复制这条链接 https://v.douyin.com/abc123/ 打开抖音")).toBe(
      "https://v.douyin.com/abc123/",
    );
  });

  it("trims trailing punctuation from shared urls", () => {
    expect(extractFirstUrl("复制此链接 https://v.douyin.com/WIsXbsZoSxA/: 打开抖音")).toBe(
      "https://v.douyin.com/WIsXbsZoSxA/",
    );
  });

  it("classifies supported final urls", () => {
    expect(classifyDouyinUrl("https://www.douyin.com/video/7649250336875613449")).toMatchObject({
      kind: "video",
      id: "7649250336875613449",
    });
  });

  it("rejects unsupported final url types", () => {
    expect(() => classifyDouyinUrl("https://www.douyin.com/music/7648217723239319537")).toThrow(
      "请粘贴抖音视频作品链接。",
    );
  });

  it("classifies official iesdouyin share intermediates as canonical works", () => {
    expect(
      classifyDouyinUrl(
        "https://www.iesdouyin.com/share/video/7637528968758324707/?region=CN&from=web_code_link",
      ),
    ).toEqual({
      finalUrl: "https://www.douyin.com/video/7637528968758324707",
      kind: "video",
      id: "7637528968758324707",
    });
  });

  it("redirects direct work urls before classifying them", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await expect(resolveDouyinInput("https://www.douyin.com/video/7649250336875613449")).resolves.toMatchObject({
      finalUrl: "https://www.douyin.com/video/7649250336875613449",
      kind: "video",
      id: "7649250336875613449",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves a short link from its first redirect location", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: {
        location:
          "https://www.iesdouyin.com/share/video/7637528968758324707/?region=CN&from=web_code_link",
      },
    }));

    await expect(resolveDouyinInput("https://v.douyin.com/XO1jdgGD8SY/")).resolves.toEqual({
      inputUrl: "https://v.douyin.com/XO1jdgGD8SY/",
      finalUrl: "https://www.douyin.com/video/7637528968758324707",
      kind: "video",
      id: "7637528968758324707",
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("labels transcript results", () => {
    expect(getFeatureLabel("audioTranscript")).toBe("转录文本");
  });

  it("builds a douyin author url from sec_uid and work id", () => {
    expect(buildAuthorUrl("MS4wLjABAAAA-author", "7638145958106205455")).toBe(
      "https://www.douyin.com/user/MS4wLjABAAAA-author?from_tab_name=main&vid=7638145958106205455",
    );
  });

  it("collects media from the douyin share page SSR payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sharePageHtml({
        item_list: [
          {
            aweme_id: "7641820631017536443",
            author: {
              avatar_thumb: { url_list: ["https://example.com/share-avatar.jpg"] },
              nickname: "分享作者",
              sec_uid: "MS4wLjABAAAA-share",
            },
            desc: "分享页文案",
            video: {
              duration: 90_000,
              cover: {
                url_list: ["https://example.com/share-cover.jpg"],
              },
              play_addr: {
                url_list: ["https://example.com/share-video.mp4"],
              },
            },
          },
        ],
      })),
    );

    await expect(
      collectWorkMetadata({
        finalUrl: "https://www.douyin.com/video/7641820631017536443",
        id: "7641820631017536443",
        kind: "video",
      }),
    ).resolves.toMatchObject({
      authorName: "分享作者",
      caption: "分享页文案",
      coverUrls: ["https://example.com/share-cover.jpg"],
      videoUrls: ["https://example.com/share-video.mp4"],
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0][0])).toBe(
      "https://www.douyin.com/share/video/7641820631017536443",
    );
  });

  it("stops after one detail interface when the share payload is complete", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(sharePageHtml({
      item_list: [{
        author: {
          avatar_thumb: { url_list: ["https://example.com/avatar.jpg"] },
          nickname: "完整作者",
        },
        desc: "完整标题",
        video: {
          duration: 90_000,
          cover: { url_list: ["https://example.com/cover.jpg"] },
          play_addr: { url_list: ["https://example.com/video.mp4"] },
        },
      }],
    })));

    await expect(collectWorkMetadata({
      finalUrl: "https://www.douyin.com/video/7641820631017536444",
      id: "7641820631017536444",
      kind: "video",
    })).resolves.toMatchObject({
      authorName: "完整作者",
      authorAvatarUrls: ["https://example.com/avatar.jpg"],
      caption: "完整标题",
      coverUrls: ["https://example.com/cover.jpg"],
      videoUrls: ["https://example.com/video.mp4"],
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("parses author metadata from douyin detail payloads", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            author: {
              nickname: " 零点未来 ",
              sec_uid: "MS4wLjABAAAA-author",
            },
          },
        },
        "7638145958106205455",
      ),
    ).toMatchObject({
      authorName: "零点未来",
      authorUrl:
        "https://www.douyin.com/user/MS4wLjABAAAA-author?from_tab_name=main&vid=7638145958106205455",
    });
  });

  it("keeps the single SSR metadata request anonymous", async () => {
    process.env.DOUYIN_COOKIE = "sessionid=prod-session";
    process.env.DOUYIN_USER_AGENT = "Browser UA from a local session";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(sharePageHtml({
      item_list: [{
        aweme_id: "7652577724216692002",
        author: {
          avatar_thumb: { url_list: ["https://example.com/avatar.jpg"] },
          nickname: "匿名作者",
        },
        desc: "匿名采集",
        video: {
          duration: 90_000,
          cover: { url_list: ["https://example.com/cover.jpg"] },
          play_addr: { url_list: ["https://example.com/video.mp4"] },
        },
      }],
    })));

    await collectWorkMetadata({
      finalUrl: "https://www.douyin.com/video/7652577724216692002",
      id: "7652577724216692002",
      kind: "video",
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://www.douyin.com/share/video/7652577724216692002",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          "user-agent": expect.stringContaining("Mobile"),
        }),
      }),
    );
    const headers = vi.mocked(globalThis.fetch).mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("cookie");
  });

  it("reads cover urls for all work types", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            video: {
              cover: {
                url_list: ["https://example.com/video-cover.jpeg"],
              },
            },
          },
        },
        "7649250336875613449",
        "video",
      ),
    ).toMatchObject({
      coverUrls: ["https://example.com/video-cover.jpeg"],
    });
  });

  it("uses full caption instead of truncated desc text", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            caption: "完整视频文案\n#AIAgent",
            desc: "短标题 完整视频文案……版本过低，升级后可展示全部信息",
          },
        },
        "7646726820692547263",
      ),
    ).toMatchObject({
      caption: "完整视频文案\n#AIAgent",
    });
  });

  it("uses complete video description when caption only contains hashtags", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            caption: "#奥利塞 #姆巴佩 #法国队 #世界杯",
            desc: "足坛顶级情商！奥利塞教科书式的赛场分寸感 #奥利塞 #姆巴佩 #法国队 #世界杯",
            preview_title: "足坛顶级情商！奥利塞教科书式的赛场分寸感 #奥利塞 #姆巴佩 #法国队 #世界杯",
          },
        },
        "7649250336875613449",
        "video",
      ),
    ).toMatchObject({
      caption: "足坛顶级情商！奥利塞教科书式的赛场分寸感 #奥利塞 #姆巴佩 #法国队 #世界杯",
    });
  });

  it("keeps lowest-bitrate video urls first by default", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            video: {
              play_addr: {
                url_list: ["https://example.com/fallback-video.mp4"],
              },
              bit_rate: [
                {
                  bit_rate: 800,
                  play_addr: {
                    height: 720,
                    width: 1280,
                    url_list: ["https://example.com/720p-video.mp4"],
                  },
                },
                {
                  bit_rate: 1600,
                  play_addr: {
                    height: 1080,
                    width: 1920,
                    url_list: ["https://example.com/1080p-video.mp4"],
                  },
                },
              ],
            },
          },
        },
        "7649250336875613449",
        "video",
      ),
    ).toMatchObject({
      videoUrls: [
        "https://example.com/720p-video.mp4",
        "https://example.com/1080p-video.mp4",
      ],
    });
  });

  it.each([
    ["lowest", "https://example.com/360p.mp4"],
    ["720p", "https://example.com/720p.mp4"],
    ["1080p", "https://example.com/1080p.mp4"],
    ["highest", "https://example.com/1080p.mp4"],
  ] as const)("selects the %s direct video source from video.bit_rate", (quality, expectedUrl) => {
    const metadata = parseWorkMetadata({
      aweme_detail: {
        video: {
          bit_rate: [
            { bit_rate: 300, play_addr: { width: 640, url_list: ["https://example.com/360p.mp4"] } },
            { bit_rate: 900, play_addr: { width: 1280, url_list: ["https://example.com/720p.mp4"] } },
            { bit_rate: 1800, play_addr: { width: 1920, url_list: ["https://example.com/1080p.mp4"] } },
          ],
          play_addr: { url_list: ["https://example.com/fallback.mp4"] },
        },
      },
    }, "7649250336875613449", "video", quality);

    expect(metadata.videoUrls?.[0]).toBe(expectedUrl);
    expect(metadata.videoUrls?.every((url) => !url.includes("/aweme/v1/play/"))).toBe(true);
  });

  it("falls back to platform play_addr when bit_rate has no comparable dimensions", () => {
    const metadata = parseWorkMetadata({
      aweme_detail: {
        video: {
          bit_rate: [
            { bit_rate: 900, play_addr: { url_list: ["https://example.com/no-width.mp4"] } },
          ],
          play_addr: { url_list: ["https://example.com/fallback.mp4"] },
        },
      },
    }, "7649250336875613449", "video", "1080p");

    expect(metadata.videoUrls).toEqual(["https://example.com/fallback.mp4"]);
  });

  it("reads video duration from douyin metadata", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            video: {
              duration: 200_000,
              play_addr: {
                url_list: ["https://example.com/video.mp4"],
              },
            },
          },
        },
        "7649250336875613449",
        "video",
      ),
    ).toMatchObject({
      durationSeconds: 200,
      videoUrls: ["https://example.com/video.mp4"],
    });
  });

  it("estimates audio cache duration from empirical video durations", () => {
    const estimate = (seconds: number) => {
      const value = estimateMediaProcessingDurationSeconds(seconds);
      expect(value).not.toBeNull();
      return value ?? 0;
    };
    const tinyVideo = estimate(1);
    const shortVideo = estimate(3 * 60 + 20);
    const mediumVideo = estimate(11 * 60 + 30);
    const longVideo = estimate(25 * 60);
    const extraLongVideo = estimate(4 * 60 * 60);

    expect(tinyVideo).toBe(10);
    expect(shortVideo).toBeGreaterThan(tinyVideo);
    expect(shortVideo).toBeLessThanOrEqual(35);
    expect(mediumVideo).toBeGreaterThan(shortVideo);
    expect(mediumVideo).toBeLessThanOrEqual(55);
    expect(longVideo).toBeGreaterThan(mediumVideo);
    expect(extraLongVideo).toBeGreaterThan(180);
    expect(estimateMediaProcessingDurationSeconds(undefined)).toBeNull();
  });

});

describe("audio transcription preparation", () => {
  it("uses the bundled ffmpeg package", () => {
    expect(resolveBundledFfmpegPath()).toContain(path.join("node_modules", "@ffmpeg-installer"));
  });

  it("prefers an explicitly configured ffmpeg binary", () => {
    process.env.FFMPEG_PATH = "/usr/local/bin/ffmpeg";

    expect(resolveFfmpegPath()).toBe("/usr/local/bin/ffmpeg");
  });

  it("creates a finalized m4a file that can be decoded", { timeout: 15_000 }, async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-audio-test-"));
    const sourcePath = path.join(tempDir, "tone.m4a");

    try {
      await runFfmpeg(resolveBundledFfmpegPath(), [
        "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-c:a", "aac", sourcePath,
      ]);
      const source = await fs.readFile(sourcePath);
      const audio = await createTranscribableAudioFileFromNode(Readable.from(source));
      try {
        await expect(probeTranscribableAudioFromUrl(audio.filePath)).resolves.toBeUndefined();
        expect(audio.contentType).toBe("audio/mp4");
        expect(audio.durationSeconds).toBeGreaterThan(0);
        expect(audio.sizeBytes).toBe((await fs.stat(audio.filePath)).size);
      } finally {
        await audio.cleanup();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

});

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  const stderr: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.join("").slice(-600)));
    });
  });
}
