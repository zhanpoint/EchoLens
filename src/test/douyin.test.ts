import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildAuthorUrl, parseWorkMetadata } from "../lib/douyin/detail";
import { buildMediaDownloadPath, canDownloadAsset } from "../lib/douyin/download";
import { normalizeAudioToWav, resolveBundledFfmpegPath } from "../lib/media/audio";
import { classifyDouyinUrl, extractFirstUrl, resolveDouyinInput } from "../lib/douyin/url";
import { EXTRACTION_FEATURES, FEATURES_BY_KIND, getFeatureLabel } from "../types/douyin";

afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(FEATURES_BY_KIND.video).toEqual(["cover", "caption", "originalTranscript", "dubbedTranscript"]);
    expect(FEATURES_BY_KIND.note).toEqual(["cover", "caption", "dubbedTranscript", "imageContent"]);
    expect(FEATURES_BY_KIND.article).toEqual(["cover", "caption", "articleText", "dubbedTranscript"]);
    expect(getFeatureLabel("cover", "video")).toBe("封面");
    expect(getFeatureLabel("caption", "article")).toBe("标题");
    expect(getFeatureLabel("caption", "note")).toBe("文案");
    expect(getFeatureLabel("caption", "video")).toBe("文案");
    expect(getFeatureLabel("originalTranscript", "video")).toBe("视频原声文本");
    expect(getFeatureLabel("dubbedTranscript", "video")).toBe("配音文本");
    expect(FEATURES_BY_KIND.video.length).toBeLessThanOrEqual(EXTRACTION_FEATURES.length);
  });

  it("builds a douyin author url from sec_uid and work id", () => {
    expect(buildAuthorUrl("MS4wLjABAAAA-author", "7638145958106205455")).toBe(
      "https://www.douyin.com/user/MS4wLjABAAAA-author?from_tab_name=main&vid=7638145958106205455",
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
      audioUrls: [],
      imageUrls: [],
    });
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
      coverUrl: "https://example.com/video-cover.jpeg",
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
      coverUrl: "https://example.com/note-first-image.webp",
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
      audioUrls: [],
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

  it("locks one high-quality primary audio url from douyin detail payloads", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            video: {
              bit_rate_audio: [
                {
                  audio_quality: 5,
                  audio_meta: {
                    bitrate: 48000,
                    url_list: {
                      main_url: "https://example.com/low-audio.m4a",
                    },
                  },
                },
                {
                  audio_quality: 6,
                  audio_meta: {
                    bitrate: 64000,
                    url_list: {
                      main_url: "https://example.com/high-audio.m4a",
                      backup_url: "https://example.com/high-backup-audio.m4a",
                    },
                  },
                },
              ],
            },
          },
        },
        "7646726820692547263",
      ),
    ).toMatchObject({
      audioUrls: ["https://example.com/high-audio.m4a"],
      imageUrls: [],
    });
  });

  it("reads music play url as the audio asset for note and article works", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            music: {
              play_url: {
                url_list: [
                  "https://sf11-cdn-tos.douyinstatic.com/obj/audio-main",
                  "https://sf6-cdn-tos.douyinstatic.com/obj/audio-backup",
                ],
              },
            },
          },
        },
        "7643144296615218021",
        "note",
      ),
    ).toMatchObject({
      audioUrls: ["https://sf11-cdn-tos.douyinstatic.com/obj/audio-main"],
    });
  });

  it("prefers the highest bitrate audio asset without trying backup urls", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            video: {
              bit_rate_audio: [
                {
                  audio_quality: 9,
                  audio_meta: {
                    bitrate: 48000,
                    url_list: {
                      main_url: "https://example.com/lower-bitrate.m4a",
                    },
                  },
                },
                {
                  audio_quality: 5,
                  audio_meta: {
                    bitrate: 96000,
                    url_list: {
                      main_url: "https://example.com/highest-bitrate.m4a",
                      backup_url: "https://example.com/highest-bitrate-backup.m4a",
                    },
                  },
                },
              ],
            },
          },
        },
        "7646726820692547263",
        "video",
      ),
    ).toMatchObject({
      audioUrls: ["https://example.com/highest-bitrate.m4a"],
    });
  });

  it("locks one high-quality primary video url from douyin detail payloads", () => {
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
      videoUrl: "https://example.com/1080p-video.mp4",
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
    expect(buildMediaDownloadPath(work, "dubbedAudio")).toBe(
      "/api/douyin/download?id=7649250336875613449&kind=video&asset=dubbedAudio",
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
    expect(canDownloadAsset("note", "dubbedAudio")).toBe(true);
    expect(canDownloadAsset("article", "dubbedAudio")).toBe(true);
    expect(canDownloadAsset("note", "originalAudio")).toBe(false);
    expect(canDownloadAsset("article", "video")).toBe(false);
  });
});

describe("audio transcription preparation", () => {
  it("uses the bundled ffmpeg package", () => {
    expect(resolveBundledFfmpegPath()).toContain(path.join("node_modules", "@ffmpeg-installer"));
  });

  it("downloads remote media before handing local files to ffmpeg", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-audio-test-"));
    const wavPath = path.join(tempDir, "tone.wav");
    const ffmpegPath = path.join(
      process.cwd(),
      "node_modules",
      "@ffmpeg-installer",
      `${process.platform}-${process.arch}`,
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );

    try {
      await runFfmpeg(ffmpegPath, [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.1",
        wavPath,
      ]);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(await fs.readFile(wavPath), {
          headers: {
            "content-length": String((await fs.stat(wavPath)).size),
          },
        }),
      );

      const output = await normalizeAudioToWav("https://example.com/video.mp4");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://example.com/video.mp4",
        expect.objectContaining({
          headers: expect.objectContaining({
            referer: "https://www.douyin.com/",
          }),
        }),
      );
      expect(output.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(output.subarray(8, 12).toString("ascii")).toBe("WAVE");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("normalizes non-MP4 audio containers through ffmpeg probing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-audio-test-"));
    const wavPath = path.join(tempDir, "tone.wav");
    const ffmpegPath = path.join(
      process.cwd(),
      "node_modules",
      "@ffmpeg-installer",
      `${process.platform}-${process.arch}`,
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );

    try {
      await runFfmpeg(ffmpegPath, [
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
