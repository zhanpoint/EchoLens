export type HttpMethod = "POST";
export type OpenApiTransport = "json";

export type OpenApiVariant = {
  label?: string;
  request?: Record<string, unknown>;
  response: Record<string, unknown>;
};

export type OpenApiEndpoint = {
  codeComments?: string[];
  description: string;
  method: HttpMethod;
  path: string;
  requestDescription?: string;
  responseDescription: string;
  title: string;
  transport: OpenApiTransport;
  variants: OpenApiVariant[];
};

export const OPEN_API_ENDPOINTS: OpenApiEndpoint[] = [
  {
    method: "POST",
    path: "/media/resolve",
    title: "解析媒体",
    description: "批量解析最多 10 个抖音或 Bilibili 分享链接，并按输入顺序返回平台、作者、封面、标题及音频、视频地址。",
    codeComments: ["inputs：抖音或 Bilibili 分享链接列表"],
    requestDescription: "inputs 为包含 1 到 10 个抖音或 Bilibili 分享链接或 Bilibili BV 号的列表。",
    responseDescription: "JSON。media 与 inputs 顺序一致；每项返回可复用的 audioUrl 和 videoUrl。",
    transport: "json",
    variants: [
      {
        label: "抖音",
        request: { inputs: ["https://v.douyin.com/example"] },
        response: {
          media: [{
            source: "douyin",
            author: { name: "示例作者", avatarUrl: "https://p3-sign.douyinpic.com/example-avatar.jpeg" },
            coverUrl: "https://p3-sign.douyinpic.com/example-cover.jpeg",
            title: "示例作品标题",
            downloads: {
              videoUrl: "https://v3-web.douyinvod.com/example.mp4",
              audioUrl: "https://public-oss.example.com/echolens/open-api/audio/douyin/123/audio.m4a",
            },
          }],
        },
      },
      {
        label: "Bilibili",
        request: { inputs: ["https://b23.tv/example"] },
        response: {
          media: [{
            source: "bilibili",
            author: { name: "示例 UP 主", avatarUrl: "https://i0.hdslb.com/example-avatar.jpg" },
            coverUrl: "https://i0.hdslb.com/example-cover.jpg",
            title: "示例视频标题",
            downloads: {
              videoUrl: "https://upos-sz-mirrorcos.bilivideo.com/example-video.m4s",
              audioUrl: "https://public-oss.example.com/echolens/open-api/audio/bilibili/BV1xx411c7mD/audio.m4a",
            },
          }],
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/transcripts/transcribe",
    title: "转录音频",
    description: "将抖音或 Bilibili 视频中的音频转写为文本。",
    codeComments: ["input：一个抖音或 Bilibili 分享链接", "model：可选 e1"],
    requestDescription: "input 为一个抖音或 Bilibili 分享链接；model 可选 e1。",
    responseDescription: "JSON。返回媒体信息和转录结果。",
    transport: "json",
    variants: [
      {
        label: "抖音",
        request: { input: "https://v.douyin.com/example", model: "e1" },
        response: {
          media: {
            source: "douyin",
            author: { name: "示例作者", avatarUrl: "https://p3-sign.douyinpic.com/example-avatar.jpeg" },
            coverUrl: "https://p3-sign.douyinpic.com/example-cover.jpeg",
            title: "示例作品标题",
            downloads: {
              videoUrl: "https://v3-web.douyinvod.com/example.mp4",
              audioUrl: "https://public-oss.example.com/echolens/open-api/audio/douyin/123/audio.m4a",
            },
          },
          transcript: {
            text: "示例转录文本",
            model: "qwen-audio-3.1-asr-flash-filetrans",
            segments: [{ startSeconds: 0, endSeconds: 3.2, text: "示例转录文本" }],
          },
        },
      },
      {
        label: "Bilibili",
        request: { input: "https://b23.tv/example", model: "e1" },
        response: {
          media: {
            source: "bilibili",
            author: { name: "示例 UP 主", avatarUrl: "https://i0.hdslb.com/example-avatar.jpg" },
            coverUrl: "https://i0.hdslb.com/example-cover.jpg",
            title: "示例视频标题",
            downloads: {
              videoUrl: "https://upos-sz-mirrorcos.bilivideo.com/example-video.m4s",
              audioUrl: "https://public-oss.example.com/echolens/open-api/audio/bilibili/BV1xx411c7mD/audio.m4a",
            },
          },
          transcript: {
            text: "示例转录文本",
            model: "qwen-audio-3.1-asr-flash-filetrans",
            segments: [{ startSeconds: 0, endSeconds: 3.2, text: "示例转录文本" }],
          },
        },
      },
    ],
  },
];

export const AGENT_ENVIRONMENT_VARIABLES = [
  { name: "ECHOLENS_BASE_URL", description: "EchoLens 服务地址，例如 http://localhost:3000" },
  { name: "ECHOLENS_API_TOKEN", description: "设置页创建的 API 访问令牌" },
];
