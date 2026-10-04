import { afterEach, describe, expect, it, vi } from "vitest";
import "./douyin-transport-test-utils";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { buildAuthorUrl, collectWorkMetadata, parseWorkMetadata } from "../lib/douyin/detail";
import { estimateMediaProcessingDurationSeconds } from "../lib/douyin/cache-estimate";
import {
  createTranscribableAudioFileFromNode,
  fetchRemoteMedia,
  muxVideoAndAudioToFile,
  probeTranscribableAudioFromUrl,
  resolveBundledFfmpegPath,
  resolveFfmpegPath,
} from "../lib/media/audio";
import { classifyDouyinUrl, extractFirstUrl, resolveDouyinUrl } from "../lib/douyin/url";
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
  it("stops CDN fallback immediately when a media request is canceled", async () => {
    const controller = new AbortController();
    const reason = new Error("download canceled");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(fetchRemoteMedia(["https://cdn.example/one", "https://cdn.example/two"], { signal: controller.signal })).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledOnce();
  });

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

    await expect(resolveDouyinUrl("https://www.douyin.com/video/7649250336875613449")).resolves.toMatchObject({
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

    await expect(resolveDouyinUrl("https://v.douyin.com/XO1jdgGD8SY/")).resolves.toEqual({
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

  it("uses authenticated web detail before anonymous share metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      aweme_detail: {
        aweme_id: "7652577724216692003",
        author: {
          avatar_thumb: { url_list: ["https://example.com/api-avatar.jpg"] },
          nickname: "认证作者",
          sec_uid: "MS4wLjABAAAA-api",
        },
        desc: "认证接口标题",
        video: {
          duration: 90_000,
          cover: { url_list: ["https://example.com/api-cover.jpg"] },
          play_addr: { url_list: ["https://example.com/api-video.mp4"] },
        },
      },
      not_login_module: { guide_login_tip_exist: true },
      status_code: 0,
    })));

    await expect(collectWorkMetadata({
      finalUrl: "https://www.douyin.com/video/7652577724216692003",
      id: "7652577724216692003",
      kind: "video",
    }, { credentialCookie: "sessionid=valid-session; msToken=test-token" })).resolves.toMatchObject({
      authorName: "认证作者",
      caption: "认证接口标题",
      coverUrls: ["https://example.com/api-cover.jpg"],
      videoUrls: ["https://example.com/api-video.mp4"],
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toContain("/aweme/v1/web/aweme/detail/");
    expect(String(url)).toContain("aweme_id=7652577724216692003");
    expect(init?.headers).toMatchObject({ cookie: "sessionid=valid-session; msToken=test-token" });
  });

  it("tries the alternate detail aid before invalidating a valid credential", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status_code: 2483,
        status_msg: "请先登录",
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        aweme_detail: {
          author: {
            avatar_thumb: { url_list: ["https://example.com/avatar.jpg"] },
            nickname: "认证作者",
          },
          desc: "候选接口标题",
          video: {
            duration: 90_000,
            cover: { url_list: ["https://example.com/cover.jpg"] },
            play_addr: { url_list: ["https://example.com/video.mp4"] },
          },
        },
        status_code: 0,
      })));

    await expect(collectWorkMetadata({
      finalUrl: "https://www.douyin.com/video/7652577724216692004",
      id: "7652577724216692004",
      kind: "video",
    }, { credentialCookie: "sessionid=valid-session; msToken=test-token" })).resolves.toMatchObject({
      authorName: "认证作者",
      caption: "候选接口标题",
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0][0])).toContain("aid=6383");
    expect(String(vi.mocked(globalThis.fetch).mock.calls[1][0])).toContain("aid=1128");
  });

  it("stops an authenticated gateway failure without trying another aid or anonymous HTML", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("blocked", { status: 403 }));
    await expect(collectWorkMetadata({ finalUrl: "https://www.douyin.com/video/700005", id: "700005", kind: "video" }, { credentialCookie: "sessionid=valid" }))
      .rejects.toMatchObject({ code: "ACCESS_BLOCKED" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the credential valid when the official self profile check succeeds", async () => {
    const loginRequired = () => new Response(JSON.stringify({
      status_code: 2483,
      status_msg: "请先登录",
    }));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(loginRequired())
      .mockResolvedValueOnce(loginRequired())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status_code: 0,
        user: { sec_uid: "MS4wLjABAAAA-self" },
      })))
      .mockResolvedValueOnce(new Response(sharePageHtml({
        item_list: [{
          author: {
            avatar_thumb: { url_list: ["https://example.com/avatar.jpg"] },
            nickname: "分享作者",
          },
          desc: "分享页标题",
          video: {
            duration: 90_000,
            cover: { url_list: ["https://example.com/cover.jpg"] },
            play_addr: { url_list: ["https://example.com/video.mp4"] },
          },
        }],
      })));

    await expect(collectWorkMetadata({
      finalUrl: "https://www.douyin.com/video/7652577724216692005",
      id: "7652577724216692005",
      kind: "video",
    }, { credentialCookie: "sessionid=valid-session; msToken=test-token" })).resolves.toMatchObject({
      authorName: "分享作者",
      caption: "分享页标题",
    });

    expect(String(vi.mocked(globalThis.fetch).mock.calls[2][0])).toContain("/user/profile/self/");
  });

  it("merges missing required fields from the share payload", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        aweme_detail: {
          author: { nickname: "认证作者" },
          desc: "认证标题",
          video: {
            duration: 90_000,
            play_addr: { url_list: ["https://example.com/video.mp4"] },
          },
        },
        status_code: 0,
      })))
      .mockResolvedValueOnce(new Response(sharePageHtml({
        item_list: [{
          author: { avatar_thumb: { url_list: ["https://example.com/avatar.jpg"] } },
          desc: "分享标题",
          video: { cover: { url_list: ["https://example.com/cover.jpg"] } },
        }],
      })));

    await expect(collectWorkMetadata({
      finalUrl: "https://www.douyin.com/video/7652577724216692006",
      id: "7652577724216692006",
      kind: "video",
    }, { credentialCookie: "sessionid=valid-session; msToken=test-token" })).resolves.toMatchObject({
      authorName: "认证作者",
      caption: "认证标题",
      authorAvatarUrls: ["https://example.com/avatar.jpg"],
      coverUrls: ["https://example.com/cover.jpg"],
      videoUrls: ["https://example.com/video.mp4"],
      durationSeconds: 90,
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

  it("uses a muxed play address instead of a video-only bitrate track", () => {
    const metadata = parseWorkMetadata({
      aweme_detail: {
        video: {
          play_addr: { url_list: ["https://example.com/muxed-video.mp4"] },
          bit_rate: [
            { bit_rate: 1800, play_addr: { url_list: ["https://example.com/video-only.mp4"] } },
          ],
        },
      },
    }, "7649250336875613449", "video");

    expect(metadata.videoUrls).toEqual(["https://example.com/muxed-video.mp4"]);
  });

  it("reads the independent DASH audio track from video.bit_rate_audio", () => {
    const metadata = parseWorkMetadata({
      aweme_detail: {
        video: {
          bit_rate_audio: [{
            audio_meta: {
              format: "dash",
              media_type: "audio",
              url_list: {
                main_url: "https://example.com/audio-main.m4a",
                backup_url: "https://example.com/audio-backup.m4a",
              },
            },
          }],
          play_addr: { url_list: ["https://example.com/muxed-video.mp4"] },
        },
      },
    }, "7649250336875613449", "video");

    expect(metadata.audioUrls).toEqual([
      "https://example.com/audio-main.m4a",
      "https://example.com/audio-backup.m4a",
    ]);
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
  it("muxes seekable input files directly and leaves their lifetime to the caller", { timeout: 15_000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "echolens-mux-test-"));
    const videoPath = path.join(directory, "video.mp4");
    const audioPath = path.join(directory, "audio.m4a");
    try {
      await runFfmpeg(resolveBundledFfmpegPath(), [
        "-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.1", "-c:v", "mpeg4", videoPath,
      ]);
      await runFfmpeg(resolveBundledFfmpegPath(), [
        "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-c:a", "aac", audioPath,
      ]);
      const file = await muxVideoAndAudioToFile(videoPath, audioPath);
      try {
        expect(file.sizeBytes).toBeGreaterThan(0);
        await expect(probeTranscribableAudioFromUrl(file.filePath)).resolves.toBeUndefined();
      } finally {
        await file.cleanup();
      }
      expect((await fs.stat(videoPath)).size).toBeGreaterThan(0);
      expect((await fs.stat(audioPath)).size).toBeGreaterThan(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

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
