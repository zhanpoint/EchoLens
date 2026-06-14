import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthorUrl, parseWorkMetadata } from "../lib/douyin/detail";
import { classifyDouyinUrl, extractFirstUrl, resolveDouyinInput } from "../lib/douyin/url";
import { FEATURES_BY_KIND, getFeatureLabel } from "../types/douyin";

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
    expect(FEATURES_BY_KIND.video).toEqual(["caption", "transcript"]);
    expect(FEATURES_BY_KIND.note).toEqual(["caption", "imageContent"]);
    expect(FEATURES_BY_KIND.article).toEqual(["caption", "articleText"]);
    expect(getFeatureLabel("caption", "article")).toBe("文章标题");
    expect(getFeatureLabel("caption", "note")).toBe("文案");
    expect(getFeatureLabel("caption", "video")).toBe("文案");
    expect(getFeatureLabel("transcript", "video")).toBe("转录文本");
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

  it("parses article markdown text from douyin detail payloads", () => {
    expect(
      parseWorkMetadata(
        {
          aweme_detail: {
            caption: "公开描述",
            preview_title: "文章标题",
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
      title: "文章标题",
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
});
