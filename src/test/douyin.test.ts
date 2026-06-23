import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildAuthorUrl, collectWorkMetadata, parseWorkMetadata } from "../lib/douyin/detail";
import { buildMediaDownloadPath, canDownloadAsset, isSupportedMediaUrl } from "../lib/douyin/download";
import {
  downloadRemoteMediaToFile,
  normalizeAudioToWav,
  resolveBundledFfmpegPath,
  resolveFfmpegPath,
} from "../lib/media/audio";
import { classifyDouyinUrl, extractFirstUrl, resolveDouyinInput } from "../lib/douyin/url";
import { EXTRACTION_FEATURES, FEATURES_BY_KIND, getFeatureLabel } from "../types/douyin";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DOUYIN_COOKIE;
  delete process.env.DOUYIN_USER_AGENT;
  delete process.env.DOUYIN_METADATA_TIMEOUT_MS;
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

  it("classifies supported final urls", () => {
    expect(classifyDouyinUrl("https://www.douyin.com/video/7649250336875613449")).toMatchObject({
      kind: "video",
      id: "7649250336875613449",
    });
    expect(classifyDouyinUrl("https://www.douyin.com/note/7648217723239319537")).toMatchObject({
      kind: "note",
      id: "7648217723239319537",
    });
    expect(classifyDouyinUrl("https://www.douyin.com/article/7649253442124320052")).toMatchObject({
      kind: "article",
      id: "7649253442124320052",
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

  it("keeps feature availability strict per work type", () => {
    expect(FEATURES_BY_KIND.video).toEqual(["cover", "caption", "originalTranscript"]);
    expect(FEATURES_BY_KIND.note).toEqual(["cover", "caption", "imageContent"]);
    expect(FEATURES_BY_KIND.article).toEqual(["cover", "caption", "articleText"]);
    expect(getFeatureLabel("cover")).toBe("封面");
    expect(getFeatureLabel("caption")).toBe("标题");
    expect(getFeatureLabel("originalTranscript")).toBe("视频文案");
    expect(FEATURES_BY_KIND.video.length).toBeLessThanOrEqual(EXTRACTION_FEATURES.length);
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
      imageUrls: [],
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

    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            images: [
              {
                url_list: ["https://example.com/note-first-image.webp"],
              },
            ],
          },
        },
        "7643144296615218021",
        "note",
      ),
    ).toMatchObject({
      coverUrls: ["https://example.com/note-first-image.webp"],
    });
  });

  it("parses article markdown text from douyin detail payloads", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            caption: "公开描述",
            preview_title: "标题",
            article_info: {
              article_content: JSON.stringify({
                markdown:
                  "第一段正文\\n\\n![图片描述](https://example.com/a.jpeg width=1080 height=603)\\n\\n**二级标题**\\n\\n第二段正文",
              }),
            },
          },
        },
        "7649253442124320052",
      ),
    ).toMatchObject({
      caption: "公开描述",
      title: "标题",
      articleText: "第一段正文\n二级标题\n第二段正文",
      imageUrls: [],
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

  it("reads note caption from the detail share text field", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            caption: "",
            share_info: {
              share_desc_info: "#在抖音，记录美好生活#第一行图文文案\n第二行图文文案\n#标签",
            },
          },
        },
        "7648217723239319537",
        "note",
      ),
    ).toMatchObject({
      caption: "第一行图文文案\n第二行图文文案\n#标签",
    });
  });

  it("does not use note share text as video caption", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            caption: "",
            share_info: {
              share_desc_info: "#在抖音，记录美好生活#不应该用于视频",
            },
          },
        },
        "7646726820692547263",
        "video",
      ),
    ).toMatchObject({
      caption: undefined,
    });
  });

  it("collects one primary image url for every note image", () => {
    const images = Array.from({ length: 6 }, (_, index) => ({
      url_list: [
        `https://example.com/image-${index + 1}-main.webp`,
        `https://example.com/image-${index + 1}-backup.webp`,
        `https://example.com/image-${index + 1}-third.webp`,
      ],
      download_url_list: [
        `https://example.com/image-${index + 1}-watermark.webp`,
      ],
    }));

    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            images,
          },
        },
        "7643144296615218021",
        "note",
      ),
    ).toMatchObject({
      imageUrls: [
        "https://example.com/image-1-main.webp",
        "https://example.com/image-2-main.webp",
        "https://example.com/image-3-main.webp",
        "https://example.com/image-4-main.webp",
        "https://example.com/image-5-main.webp",
        "https://example.com/image-6-main.webp",
      ],
    });
  });

  it("does not collect image urls for non-note work types", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            images: [
              {
                url_list: ["https://example.com/cover-or-inline-image.webp"],
              },
            ],
          },
        },
        "7646726820692547263",
        "video",
      ),
    ).toMatchObject({
      imageUrls: [],
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
    expect(canDownloadAsset("note", "cover")).toBe(true);
    expect(canDownloadAsset("note", "originalAudio")).toBe(false);
    expect(canDownloadAsset("article", "video")).toBe(false);
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

  it("downloads remote media before passing a local file to ffmpeg", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-audio-test-"));
    const wavPath = path.join(tempDir, "tone.wav");

    try {
      await runFfmpeg(resolveBundledFfmpegPath(), [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.1",
        wavPath,
      ]);
      const source = await fs.readFile(wavPath);
      let referer = "";
      let userAgent = "";
      const server = createServer((request, response) => {
        referer = request.headers.referer ?? "";
        userAgent = request.headers["user-agent"] ?? "";
        response.writeHead(200, {
          "content-length": String(source.byteLength),
          "content-type": "audio/wav",
        });
        response.end(source);
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      try {
        const { port } = server.address() as AddressInfo;
        const output = await normalizeAudioToWav(`http://127.0.0.1:${port}/video.mp4`);

        expect(referer).toBe("https://www.douyin.com/");
        expect(userAgent).toContain("Mozilla/5.0");
        expect(output.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(output.subarray(8, 12).toString("ascii")).toBe("WAVE");
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
    const wavPath = path.join(tempDir, "tone.wav");
    const partialPath = path.join(tempDir, "partial.wav");

    try {
      await runFfmpeg(resolveBundledFfmpegPath(), [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.1",
        wavPath,
      ]);
      const source = await fs.readFile(wavPath);
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
          "content-type": "audio/wav",
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

  it("normalizes non-MP4 audio containers through ffmpeg probing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-audio-test-"));
    const wavPath = path.join(tempDir, "tone.wav");

    try {
      await runFfmpeg(resolveBundledFfmpegPath(), [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.1",
        wavPath,
      ]);

      const output = await normalizeAudioToWav(await fs.readFile(wavPath));

      expect(output.byteLength).toBeGreaterThan(0);
      expect(output.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(output.subarray(8, 12).toString("ascii")).toBe("WAVE");
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
