# 配置与运行

返回 [README](../README.md)。配置从项目根目录的 `.env` 读取；新增配置请以 [.env.example](../.env.example) 为准。

## 本地依赖

- Node.js ≥ 22.3、npm。
- PostgreSQL；README 提供 PostgreSQL 17 的本地 Docker 示例，也可连接已有实例。
- 抖音网页请求使用浏览器：Windows 自动复用已安装的 Edge；其他环境安装 Playwright Chromium。
- FFmpeg 由 npm 依赖提供；生产镜像使用系统 FFmpeg。

```powershell
npx playwright install chromium
```

Windows 已安装 Edge 时不需要额外下载 Chromium。自定义浏览器路径可设置 `DOUYIN_BROWSER_EXECUTABLE`。

## 必需配置

### 数据库与密钥

| 配置 | 要求 |
| --- | --- |
| `POSTGRES_HOST`、`POSTGRES_PORT` | 可访问的数据库地址和端口 |
| `POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD` | 存在的数据库及有效账号；应用需建表、迁移和读写权限 |
| `AUTH_SESSION_SECRET` | 独立随机密钥，至少 32 个字符 |
| `AUTH_EMAIL_CODE_SECRET` | 独立随机密钥，至少 32 个字符 |
| `DATA_ENCRYPTION_KEY` | 至少 32 个字符，用于存储凭据的加密；更换后旧凭据需重新保存 |

应用自动执行事务化的数据库迁移。README 的随机密钥生成步骤只在新环境执行，避免覆盖已有加密密钥。

### 邮件验证

注册、邮箱验证码登录和找回密码使用 SMTP。配置自己的发信账号与授权密码，不能直接使用示例中的发信地址。

| 配置 | 默认行为 |
| --- | --- |
| `SMTP_USER`、`SMTP_PASSWORD` | 必填 |
| `SMTP_HOST` | `smtpdm.aliyun.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USE_SSL` | `true` |
| `SMTP_USE_TLS` | `false` |
| `SMTP_FROM` | 使用 `SMTP_USER` |

根据邮件服务商配置 SSL／TLS 和端口；必要时将上述可选变量添加到 `.env`。

### 语音识别与聊天模型

平台凭据通过 `DASHSCOPE_API_KEY` 配置；用户自己的 Key 在设置页面保存、测试和使用。当前服务使用新加坡地域的专用业务空间接口，地址固定在 [fixed-config.ts](../src/lib/dashscope/fixed-config.ts) 中。自托管使用其他业务空间时，先将这两个地址改成自己控制台提供的原生与兼容接口地址，再重新启动或构建。Key 的地域、业务空间和模型授权必须匹配。设置页面提供 [API Key 创建指引](../public/dashscope-api-key-guide.png)。

| 用途 | 配置／模型 |
| --- | --- |
| 默认识别 E1 | `DASHSCOPE_ASR_MODEL_E1=qwen-audio-3.1-asr-flash-filetrans` |
| 短音频 | 准备后的音频时长 ≤ 300 秒时自动使用 `qwen-audio-3.1-asr-flash` |
| 长音频或未知时长 | 使用 `qwen-audio-3.1-asr-flash-filetrans` |
| 转录后处理 | `DASHSCOPE_TRANSCRIPT_POSTPROCESS_MODEL=deepseek-v4.1-flash` |
| AI 总结 | `DASHSCOPE_SUMMARY_MODEL=deepseek-v4.1-flash` |
| 翻译 | `DASHSCOPE_TRANSLATION_MODEL=qwen-mt-flash` |

E2／E3 已移除。Bilibili 按各分 P 的音频时长选择识别接口。平台 Key 与用户 Key 的模型授权都需要核实；服务商价格、可用地域和调用限制以其控制台和[官方非实时识别文档](https://docs.modelstudio.console.alibabacloud.com/zh/model-studio/non-realtime-speech-recognition-user-guide)为准。

### OSS 存储

配置 `ALI_OSS_REGION`、`ALI_OSS_ENDPOINT`、`ALI_OSS_BUCKET`、`ALI_OSS_ACCESS_KEY_ID` 和 `ALI_OSS_ACCESS_KEY_SECRET`。账号必须能在指定 Bucket 写入音频并生成可访问的签名 URL；不要求把私有音频 Bucket 设为公共读。

`ALI_OSS_SIGNED_URL_EXPIRES_SECONDS` 默认 86400 秒。`ALI_OSS_PUBLIC_BUCKET` 用于开放 API 的公共媒体访问，若使用该功能，配置对应公共读路径及生命周期删除规则；不要把私有凭据或整个私有 Bucket 公开。

## 平台访问与任务运行

- 抖音需要 `DOUYIN_ACCOUNT_SERVICES_ENABLED=true`、账号访问权限和设置中已验证的访问凭据。站点可通过邀请授权开放账号服务，管理员权限按现有授权逻辑处理。
- Bilibili 在需要时使用设置中的登录凭据；作品必须可被当前账号访问。
- `BATCH_TRANSCRIBE_CONCURRENCY` 默认 `2`，合法范围 `1–8`。这是每个 Node 进程的并行数；多实例的总并行数会累加，数据库租约负责协调领取。
- 任务由 `instrumentation.register()` 注册的后台执行器处理，数据库保存任务、成功结果和识别检查点。服务重启后的接管需等待未完成执行租约过期。

更多暂停、取消、重试、导出快照和费用边界见 [博主语料采集](batch-transcription.md)。

## 生产运行

```powershell
npm ci
npm run build
npm run start
```

也可使用 [Dockerfile](../Dockerfile) 和 [Compose 配置](../deploy/compose.yml)。Compose 面向服务器部署，所需 `ECHOLENS_IMAGE`、服务器 `.env` 和镜像凭据须预先配置，不能把它当作 README 中本地数据库命令的替代。

保持 Node 服务持续运行，配置反向代理的请求大小与长请求超时，并为 PostgreSQL 配置持久卷和备份。不要把持续后台任务部署到仅在请求期间存活的 Serverless 环境。

## 常见问题

| 现象 | 检查位置 |
| --- | --- |
| 无法注册／收不到验证码 | SMTP 授权、发信地址、SSL／TLS 与端口 |
| 采集提示凭据失效或风控 | 平台账号凭据、站点开关和访问权限；稍后继续，不密集重试 |
| 筛选暂未生效 | 当前缓存范围是否完整；按页面提示重新「获取」 |
| 任务暂停 | 额度、模型授权、平台凭据或限流；修正后继续或重试 |
| 分文件导出不可选 | 使用支持目录选择的 Chrome／Edge，或合并导出、逐作品下载 |
| 提示提交确认中断 | 先核对服务商记录，再决定是否手动重试 |
