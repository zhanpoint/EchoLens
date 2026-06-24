# EchoLens

EchoLens 是一个单页面 Next.js 工具，用于从抖音分享链接识别作品类型，并按用户开启的功能提取标题、文章正文、图片可见文字或视频文案。

## 功能边界

- 支持重定向后的 `video`、`note`、`article` 三类抖音作品链接。
- 抖音详情接口用于读取作者、标题、文章正文、图片和视频资源。
- 图片内容识别走 OpenRouter 多模态模型，默认 `xiaomi/mimo-v2.5`。
- 音频转录会先用 ffmpeg 标准化为 16kHz 单声道 WAV，再走 OpenRouter ASR 模型，默认 `qwen/qwen3-asr-flash-2026-02-10`。
- 支持用户名、邮箱、密码和邮箱验证码注册，登录后才能访问核心抖音处理接口。
- 用户身份、验证码哈希和会话数据保存在 SQLite，后续需要持久化的数据也统一写入 SQLite，默认路径为 `data/echolens.sqlite`。

## 环境变量

复制 `.env.example` 到 `.env`，按需填写：

```bash
OPENROUTER_API_KEY=""
OPENROUTER_MODEL="xiaomi/mimo-v2.5"
OPENROUTER_ASR_MODEL="qwen/qwen3-asr-flash-2026-02-10"
OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
SQLITE_PATH="data/echolens.sqlite"
FFMPEG_PATH=""
AUTH_SESSION_SECRET=""
AUTH_EMAIL_CODE_SECRET=""
SMTP_HOST="smtpdm.aliyun.com"
SMTP_PORT="465"
SMTP_USER="notify@echolens.dreamlog.xyz"
SMTP_PASSWORD=""
SMTP_FROM="EchoLens <notify@echolens.dreamlog.xyz>"
SMTP_USE_SSL="true"
SMTP_USE_TLS="false"
```

`AUTH_SESSION_SECRET` 用于签名登录 Cookie，`AUTH_EMAIL_CODE_SECRET` 用于哈希邮箱验证码，生产环境必须使用 32 位以上随机字符串并保存在服务器 `.env`。如果这些密钥泄露，需要重新生成并替换。`SQLITE_PATH` 是统一服务端持久化数据库路径。SMTP 用于注册验证码、重置密码验证码和登录提醒发送。`FFMPEG_PATH` 可指定服务器上的 ffmpeg 可执行文件路径，留空时使用随包安装的 ffmpeg。

ffmpeg 路径解析规则是：优先使用 `FFMPEG_PATH`，没有配置时回退到 `@ffmpeg-installer/ffmpeg` 随包提供的可执行文件。Docker 镜像内通过 apt 安装系统 ffmpeg，并把 `FFMPEG_PATH` 固定为 `/usr/bin/ffmpeg`；本地开发默认留空，使用依赖包内置的 ffmpeg。

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

项目包含 GitHub Actions 自动部署流程：推送 `master` 分支后，CI 会先执行类型检查、Lint、测试和生产构建，再构建 Docker 镜像推送到 GHCR，最后通过 SSH 上传 `deploy/compose.yml` 并在服务器上用 Docker Compose 更新容器。生产入口建议使用 `deploy/nginx.echolens.conf` 反代到本机 `127.0.0.1:3000`，对外统一走 `80/443`。线上 SQLite 固定写入 `/app/data/echolens.sqlite`，`deploy/compose.yml` 会把 `/app/data` 挂到 Docker 命名卷 `echolens-data`，容器重启和镜像重新部署都不会丢失数据库。
