# EchoLens 工程审查与优化（2026-10-03）

本轮在现有未提交修复之上检查业务入口、共享服务、数据访问和资源生命周期，只修改有源码和回归证据的问题。

## 检查范围

| 链路 | 检查重点与证据 |
| --- | --- |
| 登录、注册、验证码、密码重置、邀请 | 鉴权入口、频率限制、用户归属；现有认证与邀请测试 |
| 抖音 / Bilibili 解析、收藏、关注、评论 | 平台客户端、凭据隔离、元数据共享、分页、媒体资源选择；平台与路由测试 |
| 原声、视频预览、下载 | 远程请求取消、FFmpeg、临时视频缓存、OSS 上传；真实本地 FFmpeg 测试与媒体测试 |
| ASR 提交、轮询、取消、额度、后处理 | 请求到服务再到存储的调用链；ASR、额度、转写路由测试 |
| 摘要、翻译、SSE | 生产者 / 消费者取消与连接释放；新增生命周期及路由回归 |
| 历史、摘要、提示词、会话缓存 | 列表 / 详情分工、用户归属、数据库迁移；存储与路由测试 |
| 设置、反馈、API 令牌、OpenAPI、CLI、MCP | 配置读取、反馈删除、令牌权限、共享客户端；现有测试、MJS 语法检查和 CLI 启动 |

扫描了 40 个 API 路由；以 app、packages、scripts 为入口分析 TypeScript 导入关系，并结合实际调用核对疑似无用导出。不能仅凭导出名称或没有 UI 按钮判断代码无用。

## 根因与修复

### 1. 数据库启动重复改写历史数据

旧实现查询了迁移版本，但仅用结果决定是否写入版本记录，仍每次执行历史表 DDL 和全量 UPDATE。进程重启会重复锁表、改写行并增加 WAL 和启动开销。

迁移现在在事务级 advisory lock 内查询版本，已完成时立即提交退出。Git 历史显示旧 v3 标记早于当前的非破坏性历史结构兼容逻辑，因此给该结构快照独立的 v5 标记，旧安装先完成一次兼容升级，再跳过重复执行；v4 也按自己的版本跳过。同步提升进程内 schema 版本，保证开发热更新能运行本次升级。

回归覆盖：带旧 v3 标记的旧历史表升级后保留用户、凭据、历史标题与会话名称；新进程加载已完成的版本时不再执行历史表 UPDATE / ALTER / DROP。核心表的原有幂等初始化仍存在。

### 2. 历史列表携带完整转写正文

侧栏列表与详情原来使用同一列集合，每次列表请求都读取、映射并传输全文和所有时间分段。页面列表缓存本来就主动压缩这两项，说明列表并不需要它们。

数据库列表查询现在仅读取元数据，保持列表原有对象结构；详情继续读取正文与分段。普通列表和搜索列表共用相同策略。回归用长正文证明列表序列化小于 2,000 字符，同时详情仍完整返回正文和分段；这是测试夹具结果，不是线上性能基准。

### 3. 流式响应取消没有贯通

HTTP 重试封装在收到响应头后移除了手工注册的外部 abort 监听，导致之后读取响应体时无法继续收到调用方取消。现在使用 Node 原生 AbortSignal.any 合并信号，保留响应体阶段的取消语义。请求头等待超时的原有定义不变。

摘要、翻译、转写统一复用现有 createJsonSseResponse。它持有操作信号，处理请求 abort、响应体 cancel 和正常关闭，结束时移除监听。调用方把操作信号传给模型 / ASR 服务；转写提交结束后若客户端已经取消，还会清理已提交的任务。删除三条路由里重复的编码、关闭和监听管理代码。

readSseJsonStream 在 [DONE] 时立即结束，并在提前结束迭代时取消上游 reader，避免继续等待长连接。媒体 CDN 请求已经取消时直接退出，不继续请求备用节点。

回归覆盖响应头之后的取消、提前退出 SSE、收到 [DONE] 后上游保持连接、响应体单独取消、预先取消、正常结束监听清理、生产者异常和 ASR 任务取消。

### 4. 并发请求重复准备同一音频

OSS HEAD 只能判断对象是否已存在，无法协调尚未完成的上传。多个请求同时看到不存在，会重复下载、提取、上传，抖音失败清理还可能干扰同一对象的并发写入。

抖音和 Bilibili 各自按稳定的音频对象键共享正在执行的 Promise；完成或失败都移除该任务，后续请求继续依赖持久化 OSS 缓存。没有新增缓存过期策略或跨平台业务耦合。

回归覆盖两平台各 10 个并发请求只下载、上传一次，以及抖音失败后可重新执行。此协调范围是单进程，不能当作跨实例分布式锁。

### 5. 删除不存在的反馈误报成功

queryRow 没找到行时返回 undefined；旧代码与 null 比较，undefined 也被视为删除成功。改为检查返回行是否存在。数据库回归覆盖不存在、首次删除、重复删除三个结果。

## 冗余清理

移除了实际无调用的 muxVideoAndAudioFromNode、putOssObject、ossObjectExists、buildTranscribeWorkPayload、resolveDouyinInput、readTranscriptHistorySummary、readTranscriptCustomPrompt、refreshDashScopeAsrJob，以及由原生信号组合取代的 linkedAbortSignal。同步清除无用 import、旧缓冲上传分支、测试 mock 和只测试废弃构造器的测试。

现有调用直接使用相应核心实现；数据库列表、删除和权限测试仍保留。Python 下载目录测试的输入从旧 workTitle 改为当前 caption，没有为旧测试增加业务兼容分支。

## 验证

- npm test：71 个文件通过，396 项通过，1 项跳过。跳过的是需要 BILIBILI_LIVE_TEST=1 的外部网络测试。
- npm run typecheck、npm run lint、npm run build：通过；生产构建生成全部页面，无构建警告。
- packages 和 scripts 的 MJS 文件：node --check 通过；CLI --help 成功。
- python -X utf8 -m unittest discover -s tests：1 项通过。
- 本地开发服务：/、/login、/api/health、/api/features 返回 200；无登录态的 /api/auth/me、/api/transcript-history 返回 401。
- PostgreSQL 迁移和 CRUD 回归使用 pg-mem 与查询桩，不等同于真实 PostgreSQL 并发压测。没有执行带用户凭据的完整平台采集或收费模型调用；MCP 仅做语法与共享客户端测试，不声称已与外部宿主完成握手。

## 机制依据

- [Node.js 22 AbortSignal.any 与 abort 机制](https://nodejs.org/docs/latest-v22.x/api/globals.html#static-method-abortsignalanysignals)：组合信号继承触发源的取消原因；采用运行时原生机制。
- [Node.js Web Streams](https://nodejs.org/docs/latest-v22.x/api/webstreams.html)：ReadableStream 的 cancel 回调负责取消底层数据源。
- [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)：事务级 advisory lock 在事务结束自动释放；版本检查与迁移执行放在同一事务内。

本轮改动保留在本地工作区，未提交、推送或部署。
