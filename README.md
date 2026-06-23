# EchoLens

EchoLens 是一个单页面 Next.js 工具，用于从抖音分享链接识别作品类型，并按用户开启的功能提取标题、文章正文、图片可见文字或视频文案。

## 功能边界

- 支持重定向后的 `video`、`note`、`article` 三类抖音作品链接。
- 抖音详情接口用于读取作者、标题、文章正文、图片和视频资源。
- 图片内容识别走 OpenRouter 多模态模型，默认 `xiaomi/mimo-v2.5`。
- 音频转录会先用 ffmpeg 标准化为 16kHz 单声道 WAV，再走 OpenRouter ASR 模型，默认 `qwen/qwen3-asr-flash-2026-02-10`。
- 第一版不保存历史，不包含账号系统和数据库。

## 环境变量

复制 `.env.example` 到 `.env`，按需填写：

```bash
OPENROUTER_API_KEY=""
OPENROUTER_MODEL="xiaomi/mimo-v2.5"
OPENROUTER_ASR_MODEL="qwen/qwen3-asr-flash-2026-02-10"
OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
OPENROUTER_MAX_AUDIO_BYTES="8388608"
EXTRACTION_TIMEOUT_MS="60000"
DOUYIN_METADATA_TIMEOUT_MS="12000"
```

转录固定使用 `@ffmpeg-installer/ffmpeg` 随包提供的 ffmpeg，避免误用 Playwright 等裁剪版 ffmpeg。

抖音详情采集使用匿名固定浏览器请求头，不读取或转发浏览器 Cookie。生产环境如果保留过 `DOUYIN_COOKIE`、`DOUYIN_USER_AGENT`、`DOUYIN_ACCEPT_LANGUAGE`，可以从 `.env` 删除，避免把本地浏览器会话耦合到服务器出口。

## 开发命令

```bash
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```

## 部署

项目包含 GitHub Actions 自动部署流程：推送 `master` 分支后，CI 会先执行类型检查、Lint、测试和生产构建，再构建 Docker 镜像推送到 GHCR，最后通过 SSH 在服务器上用 Docker Compose 更新容器。生产入口建议使用 Nginx 反代到本机 `127.0.0.1:3000`，对外统一走 `80/443`。

部署配置和服务器初始化步骤见 [`deploy/README.md`](deploy/README.md)。
