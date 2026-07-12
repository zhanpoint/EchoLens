# EchoLens

EchoLens 是一个单页面 Next.js 工具，用于从抖音分享链接识别视频作品标题，并处理视频音频转录、总结和翻译。

## 功能边界

- 仅支持重定向后的 `video` 抖音作品链接。
- 抖音详情接口用于读取作者、标题、封面和视频资源。
- 视频作品走独立转录接口，音频会先用 ffmpeg 标准化为 16kHz 单声道 WAV，再上传到阿里云 OSS 生成公网签名 URL。默认 E1 使用 DashScope `qwen3-asr-flash-filetrans` 异步转录，E2 使用 `fun-asr` 异步转录。
- 支持用户名、邮箱、密码和邮箱验证码注册，登录后才能访问核心抖音处理接口。
- 用户身份、验证码哈希、会话、转录任务和转录历史数据保存在 PostgreSQL。应用启动时会确保当前业务实际使用的表结构存在。

## 环境变量

复制 `.env.example` 到 `.env`，按需填写：

```bash
DASHSCOPE_API_KEY=""
DASHSCOPE_BASE_URL="https://your-workspace-id.ap-southeast-1.maas.aliyuncs.com/api/v1"
DASHSCOPE_ASR_MODEL_E1="qwen3-asr-flash-filetrans"
DASHSCOPE_ASR_MODEL_E2="fun-asr"
DASHSCOPE_TRANSLATION_BASE_URL="https://your-workspace-id.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
DASHSCOPE_TRANSLATION_MODEL="qwen-mt-flash"
DASHSCOPE_TRANSCRIPT_POSTPROCESS_MODEL="qwen3.6-flash"
ALI_OSS_REGION="oss-cn-hongkong"
ALI_OSS_ENDPOINT="https://oss-cn-hongkong.aliyuncs.com"
ALI_OSS_BUCKET=""
ALI_OSS_ACCESS_KEY_ID=""
ALI_OSS_ACCESS_KEY_SECRET=""
ALI_OSS_ASR_PREFIX="echolens/asr/"
ALI_OSS_SIGNED_URL_EXPIRES_SECONDS="21600"
DATABASE_URL="postgres://postgres:333444@localhost:5432/postgres"
POSTGRES_DB="echolens"
POSTGRES_USER="postgres"
POSTGRES_PASSWORD="333444"
POSTGRES_POOL_MAX="10"
FFMPEG_PATH=""
AUTH_SESSION_SECRET=""
AUTH_EMAIL_CODE_SECRET=""
DATA_ENCRYPTION_KEY=""
SMTP_HOST="smtpdm.aliyun.com"
SMTP_PORT="465"
SMTP_USER="notify@echolens.dreamlog.xyz"
SMTP_PASSWORD=""
SMTP_FROM="EchoLens <notify@echolens.dreamlog.xyz>"
SMTP_USE_SSL="true"
SMTP_USE_TLS="false"
```

`AUTH_SESSION_SECRET` 用于签名登录 Cookie，`AUTH_EMAIL_CODE_SECRET` 用于哈希邮箱验证码，`DATA_ENCRYPTION_KEY` 用于加密抖音访问凭证。生产环境必须分别配置 32 位以上的随机字符串并保存在服务器 `.env`，不得提交到代码仓库；密钥泄露后应立即轮换。`DATABASE_URL` 是本地开发连接 PostgreSQL 的连接串，默认 `postgres://postgres:333444@localhost:5432/postgres`；线上 Docker Compose 会用 `POSTGRES_DB=echolens`、`POSTGRES_USER`、`POSTGRES_PASSWORD` 生成容器内连接串并访问 `postgres:5432`。`POSTGRES_POOL_MAX` 控制服务端连接池上限。SMTP 用于注册验证码、重置密码验证码和登录提醒发送。`FFMPEG_PATH` 可指定服务器上的 ffmpeg 可执行文件路径，留空时使用随包安装的 ffmpeg。

视频音频转录使用 DashScope。`DASHSCOPE_BASE_URL` 使用百炼业务空间对应地域的 `/api/v1` 地址，`DASHSCOPE_ASR_MODEL_E1` 和 `DASHSCOPE_ASR_MODEL_E2` 分别配置 E1/E2 的真实转录模型。E1 与 E2 都走 DashScope 异步转录任务，单个音频文件大小不超过 2GB、时长不超过 12 小时；E1 固定开启情感识别和时间戳，句级时间戳使用 `enable_words: false`，不支持说话人分离和敏感词过滤；E2 支持说话人分离和敏感词过滤。翻译使用 `DASHSCOPE_TRANSLATION_BASE_URL` 的 OpenAI 兼容 `/compatible-mode/v1` 地址和 `DASHSCOPE_TRANSLATION_MODEL`，默认 `qwen-mt-flash`。转录后处理和 AI 总结共用 `DASHSCOPE_TRANSCRIPT_POSTPROCESS_MODEL`。转录任务和历史记录会写入 PostgreSQL，并尽力删除临时 OSS 对象。OSS 生命周期规则仍建议保留，用于清理异常中断时遗留的 `echolens/asr/` 临时文件。

E1/E2 异步转录统一使用主动查询任务状态。服务端提交 DashScope 异步任务后保存 `task_id`，前端按间隔请求转录状态接口，服务端通过 DashScope 任务查询接口获取完成结果并写入 PostgreSQL。

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

项目包含 GitHub Actions 自动部署流程：推送 `master` 分支后，CI 会先执行类型检查、Lint、测试和生产构建，再构建 Docker 镜像推送到 GHCR，最后通过 SSH 上传 `deploy/compose.yml` 并在服务器上用 Docker Compose 更新容器。生产入口建议使用 `deploy/nginx.echolens.conf` 反代到本机 `127.0.0.1:3000`，对外统一走 `80/443`。`deploy/compose.yml` 会启动应用容器和 PostgreSQL 17 容器，数据库名默认 `echolens`，数据写入 Docker 命名卷 `echolens-postgres`，应用通过 compose 内部服务名 `postgres` 访问数据库。PostgreSQL 只绑定服务器本机 `127.0.0.1:5432`，用于 SSH 隧道访问，不对公网开放。

Navicat 查看线上 PostgreSQL 时使用 SSH 隧道：SSH 主机填服务器公网 IP，数据库连接填 `127.0.0.1:5432`、数据库 `echolens`、用户 `postgres`。不要直接把数据库 Host 填公网 IP 做无隧道连接。
