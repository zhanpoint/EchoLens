# EchoLens

EchoLens 是一个单页面 Next.js 工具，用于从抖音分享链接识别作品类型，并按用户开启的功能提取文案、文章正文、图片可见文字或视频/音频转录。

## 功能边界

- 支持重定向后的 `video`、`note`、`article` 三类抖音作品链接。
- 抖音详情接口用于读取作者、文案、文章正文、图片和音频轨资源。
- 图片内容识别走 OpenRouter 多模态模型，默认 `xiaomi/mimo-v2.5`。
- 视频作品转录直接读取当前作品音频轨，抽取 MP3 后走 OpenRouter ASR 模型，默认 `qwen/qwen3-asr-flash-2026-02-10`。
- 第一版不保存历史，不包含账号系统和数据库。

## 环境变量

复制 `.env.example` 到 `.env`，按需填写：

```bash
OPENROUTER_API_KEY=""
OPENROUTER_MODEL="xiaomi/mimo-v2.5"
OPENROUTER_ASR_MODEL="qwen/qwen3-asr-flash-2026-02-10"
OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
OPENROUTER_MAX_SOURCE_AUDIO_BYTES="10485760"
OPENROUTER_MAX_AUDIO_BYTES="8388608"
ECHOLENS_FFMPEG_PATH=""
EXTRACTION_TIMEOUT_MS="60000"
```

转录默认使用 `@ffmpeg-installer/ffmpeg` 随包提供的 ffmpeg。只有需要指定系统 ffmpeg 时，才填写 `ECHOLENS_FFMPEG_PATH`。

## 开发命令

```bash
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```
