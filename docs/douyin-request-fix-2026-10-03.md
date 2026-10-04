# 抖音作品接口请求修复

当前评论功能仅采集和展示一级评论，新采集结果的导出文件只包含一级评论。抖音和 Bilibili 的二级评论请求、模型字段、归一化函数及回复展示已移除，采集请求数只随一级评论分页增加。已保存的历史 JSON 保留，重新采集后由新的一级评论结果覆盖。文中二级评论的实测结果保留为此前问题的诊断记录。

移除二级评论后的验证：启用真实 PostgreSQL 的全量 Vitest 共 76 个文件、447 项通过、1 项既有外网测试跳过；ESLint、TypeScript、生产构建通过。评论回归检查仅请求一级评论分页、输出无回复字段、跨页去重、游标不前进时停止、后续页失败不保存不完整快照，以及评论保存和路由行为。本次没有再次请求平台实网评论接口。

## 直接证据

2026-10-03 使用本地已保存的有效访问凭证做只读检查，没有导出 Cookie 或调用付费转录。

| 请求路径 | 实际结果 |
| --- | --- |
| 原公共参数及手动 a_bogus，账号资料接口 | HTTP 200，登录用户有效 |
| 原公共参数及手动 a_bogus，作品接口 | HTTP 403：`Blocked by ArgusSecurityPlugin Uifid Not Found` |
| 从 Cookie 传入 UIFID，作品接口 | HTTP 403：`Blocked by ArgusSecurityPlugin Signature Not Found` |
| UIFID、时间戳、手动 a_bogus，作品接口 | 仍为 `Signature Not Found` |
| 在登录主页 SDK 就绪后由页面 fetch 请求作品接口 | HTTP 200，真实公开视频列表 |

本地 API 的 503 是上游 403 的映射，Next.js 和 PostgreSQL 均正常。当前登录验证只证明资料接口可以访问，不能证明安全网关保护的作品接口接受同一种手动请求。

实际页面网络请求带有 `uifid`、`timestamp` 和 `x-secsdk-web-signature` 查询参数；最后一个签名由网页 SDK 生成，单独的 a_bogus 无法替代。修复依据是本地 `Reference_Project/douyin-downloader/core/api_client.py` 的 `_request_json_gated`（约第 710 行）及 `get_mix_aweme` 注释（约第 1264 行），其已说明受保护接口通过页面桥接发送。没有自行猜测安全签名算法。

## 修复机制

- `src/lib/douyin/page-bridge.ts` 提供网页 SDK 请求通道。每个凭证使用独立、仅内存的 BrowserContext，同一凭证串行请求并复用页面；拦截图片、媒体、字体以降低资源使用。使用 `/user/self` 初始化，等待实际带 SDK 签名的网络请求后才提交业务请求。公开首页不一定发出受保护请求，不能作为统一初始化入口。
- 全部凭证接口直接使用同一网页 SDK 通道：凭证验证、关注、作者作品、作品详情、收藏视频、收藏夹及其作品、收藏合集及其作品、一级评论。无需按端点列举通道切换规则，也不先发送手动请求试错。
- 公共查询参数仅保留 device_platform、aid、channel；业务分页参数由各业务提供。动态签名、令牌、浏览器环境由真实网页 SDK 维护。删除 `abogus.ts`、`xbogus.ts`、`ms-token.ts`、`ms-token-config.json` 及旧 token 测试，删除固定 Chrome 139 指纹、随机令牌和手动签名降级分支。
- 风控判断只读取顶层响应状态、错误消息和验证票据。原先对整个 JSON 搜索 `verify` 的实现会把作者 `custom_verify`、`enterprise_verify_reason` 认证字段及正文误判为风控，实际成功作品响应也因此被暂停 5 分钟。该扫描已删除。
- 网关 403 / 429 与完成的空响应不盲目重复；限流返回 429 和 Retry-After，业务错误在共享解析层处理。所有凭证业务共享凭证作用域冷却和平台调度；调度在页面队列的实际发送点执行，避免慢请求积累已放行请求后集中发送。仅服务端 5xx 做有限退避重试。
- 实测二级评论返回 HTTP 200、text/plain、Content-Length: 0，而网页 SDK 的 fetch/XHR Promise 不结束。现在由 SDK 发起请求，使用 Playwright `waitForResponse` 与真实网络响应读取内容；空响应立即返回 ANTI_BOT 并释放上下文，不等待 SDK 包装完成。网络请求及响应正文整体设 20 秒服务端期限，初始化导航和 SDK 就绪各有 30 秒上限。
- 凭证状态仅在明确未登录或凭证不完整时标记失效。限流、空响应、浏览器不可用及 5xx 都保留原凭证状态；设置保存发生临时错误时不覆盖原凭证。详情遇到传输错误直接传播，避免转为匿名请求后误报链接失效；成功但字段不足时仍允许分享页补齐。
- 取消贯穿凭证保存、收藏、关注、作者作品、详情加载与批量转录元数据。排队取消即时退出而不破坏前一个请求；正在执行的取消关闭其上下文，尚未发送的排队请求重新建立会话。元数据单飞按引用计数取消：一位消费者取消不影响其他消费者，最后一位退出才停止上游。删除评论采集上层的并行队列和预取，避免串行 SDK 上再堆积请求及失败后的后台任务。
- 批次遇到凭证缺失、平台限流、空响应或浏览器不可用时暂停。当前条目保持 queued、显示“等待继续”，保留服务商任务标识和分段检查点，不增加重试次数；点击继续直接恢复，不要求把暂停条目再按失败重试。明确的单作品业务错误仍单独记为失败。
- 没有运行中的批次时，任务面板轮询由 3 秒改为 15 秒；有运行任务时保持 3 秒。

## 验证

真实本地 `POST /api/batch/author-videos` 使用短期测试登录会话返回 200 和 5 条视频，测试会话结束后已删除。相同服务的另一位博主第一页返回 16 条视频、仍有下一页；下一页本次为图文过滤后的 0 条视频，但游标继续前进、仍有下一页，未误报全部获取。

统一客户端后重新验证，本地 `POST /api/batch/author-videos` 返回 HTTP 200、5 条视频，含编译和冷启动约 12.6 秒。真实凭证的验证、关注、作品、完整详情（161.003 秒）、收藏、收藏夹及其作品、合集及其作品、一级评论均返回有效数据。复用会话的接口抽样约 0.5–1.6 秒。二级评论本次仍返回空响应，现约 1.4–1.7 秒结束；随后新的个人信息验证成功，数据库凭证状态仍为 valid。不能声称已经取得被平台拒绝的二级评论。

这些是单凭证、本地网络抽样，不是跨账号、跨网络的性能承诺。没有整批拉取全部公开视频，没有进行付费 ASR；临时测试登录会话、实网诊断测试文件已删除。

启用真实 PostgreSQL 后全量 Vitest：76 个文件、446 项测试通过，剩余 1 项既有外网测试跳过。新增回归覆盖全部凭证接口共用 SDK、跨功能冷却、失败不误判凭证、空响应、请求期限、取消不打断其他消费者、失败上下文恢复、实际发送点调度，以及批次暂停后的检查点恢复。ESLint、TypeScript、生产构建通过，standalone 产物包含 Playwright 且可以实际启动 Edge。Dockerfile 浏览器安装路径已补齐，本次未构建或部署 Docker 镜像。

Playwright 用法核对了官方 [BrowserContext](https://playwright.dev/docs/api/class-browsercontext)、[BrowserType.launch](https://playwright.dev/docs/api/class-browsertype) 和 [浏览器安装](https://playwright.dev/docs/browsers) 文档。浏览器会话能修复缺失的请求契约；账号私密权限、平台主动验证码和地区限制仍由平台决定。

响应桥接与取消方式另核对官方 [Page.waitForResponse](https://playwright.dev/docs/api/class-page#page-wait-for-response)、[Response](https://playwright.dev/docs/api/class-response) 和 [Node.js 22 AbortSignal](https://nodejs.org/docs/latest-v22.x/api/globals.html#class-abortsignal)，及安装的 Playwright 1.63.0 类型定义 `playwright-core/types/types.d.ts`。响应匹配包含来源、路径、HTTP 方法、业务查询参数及 POST 表单参数，避免误消费网页后台请求。
