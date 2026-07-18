import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildAuthorUrl, collectWorkMetadata, parseWorkMetadata } from "../lib/douyin/detail";
import { estimateMediaProcessingDurationSeconds } from "../lib/douyin/cache-estimate";
import { buildMediaDownloadPath, isSupportedMediaUrl } from "../lib/douyin/download";
import {
  downloadRemoteMediaToCachedFile,
  downloadRemoteMediaToFile,
  prepareMediaCacheForWork,
  prepareTranscribableAudioFromCachedMedia,
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

  it("resolves direct work urls without a redirect request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(resolveDouyinInput("https://www.douyin.com/video/7649250336875613449")).resolves.toMatchObject({
      finalUrl: "https://www.douyin.com/video/7649250336875613449",
      kind: "video",
      id: "7649250336875613449",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves short links when redirects stop at an iesdouyin share intermediate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location:
            "https://www.iesdouyin.com/share/video/7637528968758324707/?region=CN&from=web_code_link",
        },
      }),
    );

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
              nickname: "分享作者",
              sec_uid: "MS4wLjABAAAA-share",
            },
            desc: "分享页文案",
            video: {
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

  it("falls back to the alternate detail request when the primary response has no aweme detail", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("<!doctype html><html></html>"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status_code: 0 })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            aweme_detail: {
              author: {
                nickname: "生产作者",
                sec_uid: "MS4wLjABAAAA-prod",
              },
              caption: "生产文案",
            },
          }),
        ),
      );

    await expect(
      collectWorkMetadata({
        finalUrl: "https://www.douyin.com/video/7652577724216692002",
        id: "7652577724216692002",
        kind: "video",
      }),
    ).resolves.toMatchObject({
      authorName: "生产作者",
      caption: "生产文案",
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0][0])).toBe(
      "https://www.douyin.com/share/video/7652577724216692002",
    );
    expect(String(vi.mocked(globalThis.fetch).mock.calls[1][0])).toContain("aid=6383");
    expect(String(vi.mocked(globalThis.fetch).mock.calls[2][0])).toContain("aid=1128");
  });

  it("merges partial detail payloads instead of returning metadata without media", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("<!doctype html><html></html>"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            aweme_detail: {
              author: { nickname: "间歇作者" },
              desc: "只有文案的响应",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            aweme_detail: {
              video: {
                play_addr: {
                  url_list: ["https://example.com/video-primary.mp4", "https://example.com/video-backup.mp4"],
                },
              },
            },
          }),
        ),
      );

    await expect(
      collectWorkMetadata({
        finalUrl: "https://www.douyin.com/video/7634410673426280674",
        id: "7634410673426280674",
        kind: "video",
      }),
    ).resolves.toMatchObject({
      authorName: "间歇作者",
      caption: "只有文案的响应",
      videoUrls: ["https://example.com/video-primary.mp4", "https://example.com/video-backup.mp4"],
    });
  });

  it("keeps metadata requests anonymous even when browser cookie env is present", async () => {
    process.env.DOUYIN_COOKIE = "sessionid=prod-session";
    process.env.DOUYIN_USER_AGENT = "Browser UA from a local session";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          aweme_detail: {
            author: {
              nickname: "Cookie 作者",
            },
          },
        }),
      ),
    );

    await collectWorkMetadata({
      finalUrl: "https://www.douyin.com/video/7652577724216692002",
      id: "7652577724216692002",
      kind: "video",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          referer: "https://www.douyin.com/video/7652577724216692002",
          "user-agent": expect.stringContaining("Chrome/122"),
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

  it("keeps high-quality video urls before fallback urls", () => {
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
        "https://example.com/1080p-video.mp4",
        "https://example.com/720p-video.mp4",
        "https://example.com/fallback-video.mp4",
      ],
    });
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

  it("builds canonical media download paths", () => {
    const work = {
      id: "7649250336875613449",
      kind: "video" as const,
    };

    expect(buildMediaDownloadPath(work, "originalAudio")).toBe(
      "/api/douyin/download?id=7649250336875613449&kind=video&asset=originalAudio",
    );
    expect(buildMediaDownloadPath(work, "cover", { preview: true })).toBe(
      "/api/douyin/download?id=7649250336875613449&kind=video&asset=cover&preview=1",
    );
    expect(buildMediaDownloadPath(work, "video", { preview: true })).toBe(
      "/api/douyin/download?id=7649250336875613449&kind=video&asset=video&preview=1",
    );
    expect(buildMediaDownloadPath(work, "originalAudio", { preview: true })).toBe(
      "/api/douyin/download?id=7649250336875613449&kind=video&asset=originalAudio&preview=1",
    );
    expect(buildMediaDownloadPath(work, "originalAudio", { cacheRunId: "run-1" })).toBe(
      "/api/douyin/download?id=7649250336875613449&kind=video&asset=originalAudio&cacheRunId=run-1",
    );
    expect(isSupportedMediaUrl("https://lf3-cdn-tos.douyinstatic.com/obj/example.mp4")).toBe(true);
    expect(isSupportedMediaUrl("https://example-unknown-cdn.com/media.m4a")).toBe(true);
    expect(isSupportedMediaUrl("http://example.com/unsafe.mp4")).toBe(false);
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

  it("extracts audio from a completed cached media file", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-audio-test-"));
    const sourceAudioPath = path.join(tempDir, "tone.m4a");

    try {
      await runFfmpeg(resolveBundledFfmpegPath(), [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.1",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        sourceAudioPath,
      ]);
      const source = await fs.readFile(sourceAudioPath);
      let referer = "";
      let requestCount = 0;
      let userAgent = "";
      const server = createServer((request, response) => {
        requestCount += 1;
        referer = request.headers.referer ?? "";
        userAgent = request.headers["user-agent"] ?? "";
        response.writeHead(200, {
          "content-length": String(source.byteLength),
          "content-type": "audio/mp4",
        });
        response.end(source);
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      try {
        const { port } = server.address() as AddressInfo;
        const mediaUrl = `http://127.0.0.1:${port}/video.mp4`;
        const userA = "user-a";
        const userB = "user-b";
        const mediaCacheKey = "video:7644929016692636809:video";
        await prepareMediaCacheForWork(userA, "video:7644929016692636809");
        const cachedMedia = await downloadRemoteMediaToCachedFile(userA, mediaUrl, { cacheKey: mediaCacheKey });
        const audio = await prepareTranscribableAudioFromCachedMedia(userA, mediaCacheKey);
        const audioCachePath = path.join(
          os.tmpdir(),
          "echolens-audio-cache",
          `${createHash("sha256").update(JSON.stringify([userA, "stable", mediaCacheKey])).digest("hex")}.m4a`,
        );
        const otherUserAudioCachePath = path.join(
          os.tmpdir(),
          "echolens-audio-cache",
          `${createHash("sha256").update(JSON.stringify([userB, "stable", mediaCacheKey])).digest("hex")}.m4a`,
        );
        const audioMtime = (await fs.stat(audioCachePath)).mtimeMs;
        await prepareMediaCacheForWork(userA, "video:7644929016692636809");
        await prepareTranscribableAudioFromCachedMedia(userA, mediaCacheKey);

        expect(referer).toBe("https://www.douyin.com/");
        expect(userAgent).toContain("Mozilla/5.0");
        expect(audio.contentType).toBe("audio/mp4");
        expect(path.extname(audio.filePath)).toBe(".m4a");
        expect(audio.durationSeconds).toBeGreaterThan(0);
        expect(audio.sizeBytes).toBeGreaterThan(0);
        await expect(fs.readFile(cachedMedia.filePath)).resolves.toEqual(source);
        expect((await fs.stat(audioCachePath)).mtimeMs).toBe(audioMtime);
        expect(requestCount).toBe(1);

        await prepareMediaCacheForWork(userB, "video:7644929016692636809");
        await downloadRemoteMediaToCachedFile(userB, mediaUrl, { cacheKey: mediaCacheKey });
        await prepareTranscribableAudioFromCachedMedia(userB, mediaCacheKey);
        expect(requestCount).toBe(2);

        await prepareMediaCacheForWork(userA, "video:7644929016692636810");
        await expect(fs.stat(audioCachePath)).rejects.toThrow();
        await expect(fs.stat(otherUserAudioCachePath)).resolves.toBeTruthy();
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resumes partially downloaded remote media files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-audio-test-"));
    const partialPath = path.join(tempDir, "partial.bin");

    try {
      const source = Buffer.from("0123456789".repeat(1024));
      const firstChunkSize = Math.floor(source.byteLength / 2);
      let resumedRange = "";
      await fs.writeFile(partialPath, source.subarray(0, firstChunkSize));
      const server = createServer((request, response) => {
        resumedRange = request.headers.range ?? "";
        if (!resumedRange) {
          response.writeHead(416);
          response.end();
          return;
        }

        const start = Number(resumedRange.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
        response.writeHead(206, {
          "content-length": String(source.byteLength - start),
          "content-range": `bytes ${start}-${source.byteLength - 1}/${source.byteLength}`,
          "content-type": "application/octet-stream",
        });
        response.end(source.subarray(start));
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      try {
        const { port } = server.address() as AddressInfo;
        await downloadRemoteMediaToFile(`http://127.0.0.1:${port}/video.mp4`, partialPath);
        const output = await fs.readFile(partialPath);

        expect(resumedRange).toBe(`bytes=${firstChunkSize}-`);
        expect(output.equals(source)).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restarts a partial media download when the upstream CDN ignores range requests", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-audio-test-"));
    const outputPath = path.join(tempDir, "partial.bin");
    const source = Buffer.from("complete-media-after-range-reset");
    const firstChunkSize = 8;
    const ranges: string[] = [];

    try {
      await fs.writeFile(outputPath, source.subarray(0, firstChunkSize));
      const server = createServer((request, response) => {
        ranges.push(request.headers.range ?? "");
        response.writeHead(200, {
          "content-length": String(source.byteLength),
          "content-type": "video/mp4",
        });
        response.end(source);
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      try {
        const { port } = server.address() as AddressInfo;
        await downloadRemoteMediaToFile(`http://127.0.0.1:${port}/video.mp4`, outputPath);

        await expect(fs.readFile(outputPath)).resolves.toEqual(source);
        expect(ranges).toEqual([`bytes=${firstChunkSize}-`, ""]);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to the next media url when the primary CDN url fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-audio-test-"));
    const outputPath = path.join(tempDir, "media.bin");
    const source = Buffer.from("stable-backup-media");

    try {
      const server = createServer((request, response) => {
        if (request.url === "/primary.mp4") {
          response.writeHead(503);
          response.end();
          return;
        }

        response.writeHead(200, {
          "content-length": String(source.byteLength),
          "content-type": "video/mp4",
        });
        response.end(source);
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      try {
        const { port } = server.address() as AddressInfo;
        await downloadRemoteMediaToFile(
          [
            `http://127.0.0.1:${port}/primary.mp4`,
            `http://127.0.0.1:${port}/backup.mp4`,
          ],
          outputPath,
        );

        await expect(fs.readFile(outputPath)).resolves.toEqual(source);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reuses an in-flight media cache task when the same work starts a new cache run", async () => {
    const firstChunk = Buffer.from("partial-");
    const secondChunk = Buffer.from("complete");
    const source = Buffer.concat([firstChunk, secondChunk]);
    let closeFirstResponse: (() => void) | undefined;
    let resolveFirstRequestSeen!: () => void;
    let resolveFirstConnectionClosed!: () => void;
    let requestCount = 0;

    const firstRequestSeen = new Promise<void>((resolve) => {
      resolveFirstRequestSeen = resolve;
    });
    const firstConnectionClosed = new Promise<void>((resolve) => {
      resolveFirstConnectionClosed = resolve;
    });
    const server = createServer((request, response) => {
      requestCount += 1;
      resolveFirstRequestSeen();
      response.writeHead(200, {
        "content-length": String(source.byteLength),
        "content-type": "video/mp4",
      });
      response.write(firstChunk);
      request.on("close", resolveFirstConnectionClosed);
      closeFirstResponse = () => response.end(secondChunk);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { port } = server.address() as AddressInfo;
      const userId = "same-work-run-user";
      const mediaUrl = `http://127.0.0.1:${port}/video.mp4`;
      await prepareMediaCacheForWork(userId, "video:same-work-run", "run-1");
      const first = downloadRemoteMediaToCachedFile(userId, mediaUrl);
      await firstRequestSeen;
      await prepareMediaCacheForWork(userId, "video:same-work-run", "run-2");
      const second = downloadRemoteMediaToCachedFile(userId, mediaUrl);
      closeFirstResponse?.();

      const [firstCached, secondCached] = await Promise.all([first, second]);
      expect(secondCached.filePath).toBe(firstCached.filePath);
      expect(requestCount).toBe(1);
      await expect(fs.readFile(firstCached.filePath)).resolves.toEqual(source);
      await firstConnectionClosed;
    } finally {
      closeFirstResponse?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("reuses completed cached media across cache runs", async () => {
    const source = Buffer.from("already-cached-media");
    let requestCount = 0;
    const server = createServer((request, response) => {
      requestCount += 1;
      response.writeHead(200, {
        "content-length": String(source.byteLength),
        "content-type": "video/mp4",
      });
      response.end(source);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { port } = server.address() as AddressInfo;
      const userId = "cache-hit-user";
      const mediaUrl = `http://127.0.0.1:${port}/video.mp4`;
      await prepareMediaCacheForWork(userId, "video:cache-hit", "run-1");
      const first = await downloadRemoteMediaToCachedFile(userId, mediaUrl);
      await prepareMediaCacheForWork(userId, "video:cache-hit", "run-2");
      const second = await downloadRemoteMediaToCachedFile(userId, mediaUrl);

      expect(second.filePath).toBe(first.filePath);
      expect(requestCount).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("clears completed cached media only when the user switches to a different work", async () => {
    const source = Buffer.from("single-work-cache");
    const server = createServer((request, response) => {
      response.writeHead(200, {
        "content-length": String(source.byteLength),
        "content-type": "video/mp4",
      });
      response.end(source);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { port } = server.address() as AddressInfo;
      const userId = "switch-work-user";
      const mediaUrl = `http://127.0.0.1:${port}/video.mp4`;
      await prepareMediaCacheForWork(userId, "video:first", "run-1");
      const first = await downloadRemoteMediaToCachedFile(userId, mediaUrl);

      await expect(fs.stat(first.filePath)).resolves.toBeTruthy();
      await prepareMediaCacheForWork(userId, "video:second", "run-2");
      await expect(fs.stat(first.filePath)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
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
