# 参考项目更新与 EchoLens 对照

日期：2026-10-03。范围：本地参考仓库的提交与源代码，EchoLens 当前已有业务及调用链。

## 版本与比较边界

- `Reference_Project/bilibili-downloader`：`main` 从 `000293e1` 快进到 `e3d6aff3`，范围内共 79 个提交（包含合并提交），183 个文件发生变化。
- `Reference_Project/douyin-downloader`：已纠正远程为 `https://github.com/jiji262/douyin-downloader.git`，撤销错误的跨项目合并；本地 `main` 从原抖音提交 `203c1ae0` 快进 11 个提交至 `9874f413`，与其 `origin/main` 一致。
- 两个参考项目独立保存，没有跨项目合并或备份分支。本报告下方的抖音机制对照基于 `203c1ae0` 的已有实现；新增的 11 个抖音提交已完成独立逐项源码对照，见 [抖音增量审查](douyin-update-audit-2026-10-03.md)；不能将此前 Bili23 的 79 个提交视为抖音更新。
- EchoLens 使用 TypeScript/Next.js，参考项目主要使用 Python/Qt。是否吸收按业务机制和实际调用关系判断，不能用 Git 是否包含某个 Python 提交来判断是否已同步。
- 下方保留全部 79 个提交的索引；核心下载、网络、缓存、FFmpeg、任务状态等变化与本地实现做了源码对照。桌面 UI、发行、翻译及测试资源通过对应领域归类，不逐份搬运。

## 更新领域及采纳结果

| 上游变化与代表提交 | EchoLens 现状 | 本次处理 |
| --- | --- | --- |
| 分片必须写满、限制写入边界、根据已写字节续传：`057fe23f` | 原分片器事后检查响应长度，忽略 `bytesWritten`，失败即从头重下；且该模块没有生产调用者 | 整理为媒体层 `downloadMediaFile`，接入两平台的临时 DASH 视频合流；先验证范围再写入，处理短写，按已写偏移续传，失败取消并等待并发任务收尾 |
| CDN 完整候选覆盖、滑动窗口探测：`d21078b3` | 原模块逐个探测，每个请求最长 120 秒；慢首选拖住后备节点 | 最多 4 个探测并发，单候选探测预算 5 秒，首个有效候选启动下载，取消其他探测。失败时继续扫描后续候选，不靠整体预算丢弃候选 |
| FFmpeg 无响应终止、最终状态收敛：`41e88f71`、`32daaf0d` | 三份子进程管理实现；超时发送 SIGTERM 后立即 reject，调用者可能在进程仍占用文件时删除输入 | 统一 `runFfmpegProcess`；进度心跳、整体期限、SIGTERM 后的 SIGKILL 升级，等待 `close` 后才结算及清理文件 |
| 封面缓存合并请求、生命周期清理：`23322f38`；运行状态独立于配置：`3cfb1a4d`、`667b2e65` | 已有 IndexedDB 会话缓存、服务器 Promise 合并及引用计数；抖音服务端元数据仅以“已认证/匿名”区分凭证 | 保留原有合并机制；凭证指纹进入 key，Open API 以策略对象的 WeakMap 划分作用域，避免不同凭证/策略共用一次采集 |
| WBI 密钥获取、退避重试、匿名恢复：`78bc5c6d` | `bilibili/client.ts` 已按需获取 nav、必要时获取 buvid 再取 nav，并复用 HTTP 重试；密钥不落盘 | 已具备关键机制。没有引入桌面全局登录态缓存，以免把单用户状态模型搬进多用户服务 |
| 画质依据 `support_formats` 声明、按需补取流：`532d8930`、`7b9b71ad`；编码降级说明：`a180d91e` | 已按用户画质发送 qn，并有匿名/凭证请求和流降级选择；没有上游的动态画质与实际编码提示模型 | 保留现有选流行为。动态画质/编码展示需扩展 API 与界面契约，作为独立功能处理；本次不假称已实现 |
| 独立音频转封装：`740f1189`、`905e3821`、`190e7167` | 视频抽音频已输出 finalized M4A；Bili 原音频及 Open API DASH 音频仍有直接上传路径 | 抽取与探测的进程管理已统一。没有强制所有可直接使用的音频额外重封装；格式兼容需以真实源样本和 ASR 接受能力验证 |
| 任务完成先持久化：`59607283` | 转录 SSE 路由先 await `saveTranscriptHistory`，随后发送 done；数据库有事务封装 | 核心顺序已经满足。没有增设另一份任务完成状态 |
| 网络失败自动重新排队：`dc234341` | 已有 `http/retry.ts`、网络错误码与 UI 重试；转录/上传有独立任务状态 | 保留现有退避机制，不叠加桌面重排队层。媒体文件续传与取消作为下载内部机制实现，文件写入失败不按 CDN 错误重试 |
| 列表播放页与跨分页定位：`1d309d2f`、`77a79932`、`8f8b2a3e`；共用列表骨架：`df374f6e` | 已支持投稿 BV、分 P、收藏/关注分页；没有上游完整剧集、课程与 list 播放页模型 | 属于链接/内容类型扩展，不是当前下载路径重构的必要项。没有通过关键词规则把列表地址误认作单视频 |
| 命名规则可视化及类型迁移：`65e690ec`、`1bbc8c77`、`d9897b69` 等 | 已有目录组织枚举、命名清洗、浏览器目录句柄与用户设置 | 保留轻量目录组织；Qt 规则编辑器、配置整表重置与课程命名体系不适用于当前界面 |
| 延迟导入、错误可观测性、质量基线：`d72a9667`、`5806af5f`、`3d53b649`、`9c0802a7` | 已有 lint、严格类型检查、Vitest、部署前 verify 工作流 | 新增下载异常、进程收尾和缓存隔离回归；删除原分片器入口及重复进程管理路径，保持一份生产实现 |
| 延迟导入与发行边界：`d72a9667`、Windows 启动器/打包系列提交 | FFmpeg installer 在模块初始化时加载；构建错误地把运行时路径追踪成整个项目目录 | 改为使用时加载 FFmpeg；临时文件路径明确排除构建追踪，所需 installer 包和平台二进制显式纳入 standalone 资源。构建警告消失，源码、测试、脚本等整个项目目录不再被带入 |
| 出口区域检测、PCDN/Akamai 节点名单：`fb818568`、`a8002b21`、`815656a9` | 使用平台返回的源 URL 与 backup URL，不重写 CDN hostname | 借鉴按候选探测的机制，没有硬编码地区/节点替换规则；保留平台签名 URL 和原 Referer |
| PyStand、安装/卸载签名、Qt 窗口/控件、字体、翻译、版本更新 SDK | EchoLens 为 Web 应用，发行由 Docker/GitHub Actions 完成 | 无直接运行时迁移对象，不引入桌面打包或 Qt 依赖 |

## 原抖音基线中可核对的工程思想

这些是原抖音 `203c1ae0` 基线的已有内容，不是新增 11 个提交的增量审查结果。

- `16b6c9c2`：HTTPX 回退移出事件循环，`storage/file_manager.py` 使用异步/线程协作处理下载。EchoLens 使用 Node 异步文件 API 和流，保留这一非阻塞方向。
- `a77ac709`、`1d67dc76`：下载时间窗口、增量恢复与作者目录。EchoLens 已有作者目录组织；批量主页下载与持久化 Range 断点属于另一类业务，未强行加入现有转录流程。
- `99bb559a`：直播回放进度。EchoLens 当前投稿视频转录未提供该直播回放下载模型，无对应迁移点。
- 原抖音下载器分别限制总时长、连接等待和读停滞。此次媒体下载保留有界并发、单次/分片期限与取消传播；FFmpeg 另外区分无输出停滞和整体处理超时。

## 本次最终实现的约束

- `src/lib/media/range-downloader.ts` 是唯一的分片文件下载实现；旧 Bili 专用文件已删除，没有兼容空壳或第二套入口。
- 探测最多 4 个并发；文件下载为 4 MiB 分片，最多 4 个写入 worker，每个 worker 单独拥有文件描述符。临时合流仍受原有合流并发及队列限制。
- 分片响应的起点、终点、总长度与请求匹配后才写入。短写按 `bytesWritten` 推进偏移；中断保留本次进程内的已写进度；不新增跨重启断点数据库。
- 单个分片全部续传共用 120 秒期限；连续没有推进的候选扫描最多 5 轮。既不会无限循环，也不把部分进展一律当作重下整片。
- 输入有已知大小时先检查单文件限额；不支持 Range 或未知长度时顺序流下载仍检查限额和已知总长度。
- 服务端虽声明支持 Range、实际仍返回 200 时，等待所有分片退出后重新顺序下载；不把整文件响应写进某个分片。
- 临时视频的两路下载共享取消信号。失败等待两路退出，成功合流后释放输入；FFmpeg 直接打开输入路径，不再把它们复制到合流目录。
- FFmpeg 统一输出 progress 心跳，5 分钟无输出视为停滞，取消/超时先 SIGTERM，10 秒后仍未退出则 SIGKILL；Promise 等待子进程及管道关闭再结束。
- 同凭证、同策略的元数据采集合并仍然生效；不同凭证或不同策略对象分别采集。指纹只用于内存 key，不记录明文凭证。
- 项目明确要求 Node.js >=22.3.0，与现有 Node 22 CI/Docker 方向一致；当前本机 Node 24 满足要求。原生运行时模块加载使用此版本起提供的 `process.getBuiltinModule`。

## 验证依据与限制

回归覆盖 CDN 后备选择、慢探测取消、Content-Range 错配、相邻分片越界、截断续传、文件短写、磁盘写入无进展、输入限额、失败时并发收尾、缓存作用域隔离，以及 FFmpeg 心跳/超时/强制终止/close 顺序。真实 FFmpeg 冒烟覆盖 M4A 抽取、文件输入合流和输出音频解码。

官方依据：Node.js [FileHandle.write](https://nodejs.org/docs/latest-v22.x/api/fs.html#filehandlewritebuffer-offset-length-position) 的实际写入字节返回值与文件操作生命周期；[child_process close 事件](https://nodejs.org/docs/latest-v22.x/api/child_process.html#event-close) 的子进程/管道关闭语义；[kill](https://nodejs.org/docs/latest-v22.x/api/child_process.html#subprocesskillsignal) 发送信号的语义。上游依据来自本地 main 与对应提交差异，不依赖过时的变更日志版本号。

原生加载与运行时版本依据：[process.getBuiltinModule](https://nodejs.org/docs/latest-v22.x/api/process.html#processgetbuiltinmoduleid)。运行时临时路径的 tracing ignore 用法依据本地 Next.js 16.2.11 构建诊断；静态资源手工纳入依据同版本 `NextConfig.outputFileTracingIncludes` 定义及实际构建/产物检查。

最终验证：TypeScript、ESLint 通过；69 个测试文件通过，374 项测试通过、1 项有条件的 Bili live 测试跳过；生产构建成功且无此前的 NFT 追踪警告。独立加载 standalone 内的 FFmpeg 包确认二进制存在、解析路径位于产物内；媒体 API trace 不再包含 `next.config.ts`，FFmpeg 资源仍在 trace 中。本地首页与数据库健康接口另做运行检查。

没有在真实抖音/Bili 网络上做大批量吞吐量测试，因此不声明提速倍数或外部服务可用率。完成单元及本地集成测试不能证明生产网络、账号风控、OSS 上传或外部 ASR 的端到端吞吐。

## Bili 快进范围的完整提交索引

以下按提交历史从旧到新列出 79 个提交；其中合并、翻译、发行和桌面修改同样保留，便于后续追踪。

- [532d8930](https://github.com/ScottSloan/Bili23-Downloader/commit/532d89309bdf26e4c10ff0cc0698e5661cafff09) fix: complete missing video quality streams
- [df58d97f](https://github.com/ScottSloan/Bili23-Downloader/commit/df58d97f8d658a46dfaf995717734f07f1a51a01) Merge pull request #459 from TomorrowX6/fix/video-quality-streams
- [7b9b71ad](https://github.com/ScottSloan/Bili23-Downloader/commit/7b9b71ad621e794411727a8b300ab6ea511a1ff8) ♻️ refactor: 画质列表改以 support_formats 为准，视频流按需补取
- [057fe23f](https://github.com/ScottSloan/Bili23-Downloader/commit/057fe23ff68eed7b0274906e69698c22da13661e) 🐛 fix: 修复分片未写满却被判定完成导致视频不完整的问题
- [3d53b649](https://github.com/ScottSloan/Bili23-Downloader/commit/3d53b6498578bcc3894bfe8b2a2e155042f0eb3c) 👷 build: 引入 pytest 与 ruff，建立测试与质量检查基线
- [b9c9e5ba](https://github.com/ScottSloan/Bili23-Downloader/commit/b9c9e5ba82d91cda595a275505b6b04204956014) 🔥 remove: 移除无引用的解析列表旧模型
- [1be6e87f](https://github.com/ScottSloan/Bili23-Downloader/commit/1be6e87f5c801ea89741628dc5f7420c8715c659) 🐛 fix: 修复个人空间用户名缓存未生效的问题
- [35080215](https://github.com/ScottSloan/Bili23-Downloader/commit/3508021589447c747f2786f176576340cd61ec8f) 🐛 fix: 移除弹幕 XML 中被静默丢弃的 weight 参数
- [9c0802a7](https://github.com/ScottSloan/Bili23-Downloader/commit/9c0802a713d1b4ee101c97fc9db25ee168874b3d) ♻️ refactor: 清理未使用与重复的导入，并将对应规则纳入门禁
- [982b5d03](https://github.com/ScottSloan/Bili23-Downloader/commit/982b5d030324af7f9b1e07eeeeae23dba0d64804) ✅ test: 补充配置文件跨版本迁移的测试
- [3cfb1a4d](https://github.com/ScottSloan/Bili23-Downloader/commit/3cfb1a4daf6330ee1d1170494f9ac8cef9c38479) ♻️ refactor: 将进程级运行时状态从配置对象中剥离
- [0449ecba](https://github.com/ScottSloan/Bili23-Downloader/commit/0449ecba6ac57c7bcb0be76818a62b68b45de0ad) ✅ test: 补充平铺列表类解析器的特征测试
- [df374f6e](https://github.com/ScottSloan/Bili23-Downloader/commit/df374f6eb60de20a75d4614751a43de6098230b1) ♻️ refactor: 抽取平铺列表类解析器的共用骨架
- [17f2407b](https://github.com/ScottSloan/Bili23-Downloader/commit/17f2407bd1643ebac06120676f6bba34e5888405) 🐛 fix: 历史记录数据库自行确保目录存在，并补充翻译上下文一致性测试
- [3c649122](https://github.com/ScottSloan/Bili23-Downloader/commit/3c649122ed6fe1df8d4bbc3c639586f6a1e27d33) ♻️ refactor: 合并 ParseBase 与 MainWindowBase 两个伪基类
- [667b2e65](https://github.com/ScottSloan/Bili23-Downloader/commit/667b2e65aeb15b44e71ab3ddab893d53cdbe14cc) ♻️ refactor: 标注类级共享状态，并为配置默认值加上污染防护
- [5806af5f](https://github.com/ScottSloan/Bili23-Downloader/commit/5806af5f3b1ce6be9659fc4e310eda4e5e6a080f) ♻️ refactor: 收窄异常捕获，消除无声吞掉异常的写法
- [d72a9667](https://github.com/ScottSloan/Bili23-Downloader/commit/d72a9667720f35c8cadba28cae662edc44d74f41) ⚡️ perf: 把解析历史建库与 httpx 导入移出启动路径
- [41e88f71](https://github.com/ScottSloan/Bili23-Downloader/commit/41e88f7182f89e2d106fcd4c4ea263014fe609b8) 🐛 fix: 修复合并阶段进度不显示，以及 FFmpeg 无响应导致任务僵死
- [5ced79cd](https://github.com/ScottSloan/Bili23-Downloader/commit/5ced79cd82c31c6e0049b9e902d3584e1e64ce58) ✨ feat: 启动时补检一次剪贴板
- [59607283](https://github.com/ScottSloan/Bili23-Downloader/commit/5960728304d266f268657eed6aeb6d316e4a2d05) 🐛 fix: 任务完成状态在销毁下载器之前落盘
- [65e690ec](https://github.com/ScottSloan/Bili23-Downloader/commit/65e690ec4a9b5fab180879dcc0b44cdce0295556) ✨ feat: 新增命名规则的可选段求值引擎与结构模型
- [1bbc8c77](https://github.com/ScottSloan/Bili23-Downloader/commit/1bbc8c771b86f296b9db86d57bd74de23a7bdd56) ✨ feat: 命名规则改为可视化编辑，一条规则同时适配单P与多P
- [44ffb112](https://github.com/ScottSloan/Bili23-Downloader/commit/44ffb112fe71577de44f088b8347302ad5be8aa7) ✅ test: 修复启动冒烟测试在 Windows 上偶发崩溃
- [8f8b2a3e](https://github.com/ScottSloan/Bili23-Downloader/commit/8f8b2a3e0ba0fcecda946dd182269d360a2906c7) ✨ feat: 通过MCP服务解析剧集时支持获取链接所指向的视频
- [a26f3813](https://github.com/ScottSloan/Bili23-Downloader/commit/a26f38139cb36fd2b0a4c415f8d96ec043e939c2) ✨ feat: 优化命名规则编辑器的布局与片段编辑体验
- [38dbf3ce](https://github.com/ScottSloan/Bili23-Downloader/commit/38dbf3ce9ac7e32ba8aaf361c6bb2404a41cc041) 🐛 fix: 切换命名规则时闪过一排空窗口
- [8c16efff](https://github.com/ScottSloan/Bili23-Downloader/commit/8c16efffa8d8a67fc2d7efc02f41d8a62ad5a04c) 🐛 fix: 修复主窗口最小化到托盘时程序自行退出
- [815656a9](https://github.com/ScottSloan/Bili23-Downloader/commit/815656a9b210180262cc0843f3b64e3289ad3011) 🐛 fix: 移除不可用的 Akamai 节点并补充 PCDN 黑名单
- [fb818568](https://github.com/ScottSloan/Bili23-Downloader/commit/fb81856888cdb6cd57a57d7cc28e7b7405a5e251) ✨ feat: 首次启动自动检测出口地区以选择 CDN 列表
- [5523d6c0](https://github.com/ScottSloan/Bili23-Downloader/commit/5523d6c030796750ecb037b008a75e0717122815) 🐛 fix: 更正 Akamai 403 的成因说明
- [a8002b21](https://github.com/ScottSloan/Bili23-Downloader/commit/a8002b21a993d976ffe07c79c976b66934462349) ✨ feat: 港澳台改用国内 CDN 列表
- [621686b4](https://github.com/ScottSloan/Bili23-Downloader/commit/621686b458427b41456b803353e996b05ed9af6e) 👷 build: translate.py 一次更新全部目标语言
- [99f4dc58](https://github.com/ScottSloan/Bili23-Downloader/commit/99f4dc58d93939d3f26cd190b40a192783410099) 🐛 fix: 修复下载选项回落到不了 runtime 的问题
- [190e7167](https://github.com/ScottSloan/Bili23-Downloader/commit/190e7167c14588e558bcdec03deb8f30f9cd1e8d) ♻️ refactor: 移除已停止调用的 m4a 容器修复逻辑
- [740f1189](https://github.com/ScottSloan/Bili23-Downloader/commit/740f11893edb13c71c1009fccda9b936a09e3248) ✨ feat: 独立音频流交付前统一重封装
- [905e3821](https://github.com/ScottSloan/Bili23-Downloader/commit/905e382149fcd533c0e0dfcb631ad336e562398e) 🐛 fix: 保留原始文件时对音频做重封装
- [a180d91e](https://github.com/ScottSloan/Bili23-Downloader/commit/a180d91edd9bf7e13403a18cdf78e1a4159d86d7) ✨ feat: 所选编码不存在时提示实际下载的编码
- [1c16f336](https://github.com/ScottSloan/Bili23-Downloader/commit/1c16f3364f2f8e68c2c61866ea7aed95c0fa53fe) ✨ feat: 媒体选项在设置界面也能改，并改为持久化
- [80494c7d](https://github.com/ScottSloan/Bili23-Downloader/commit/80494c7d792f3392a98ee5a5a3096adcc663ef06) 🌐 lang: 媒体选项的说明改为从用户结果出发
- [c87a7f8f](https://github.com/ScottSloan/Bili23-Downloader/commit/c87a7f8fd58209c07c20b4d74573e4f9ef9f6d31) 📝 docs: 补全 2.22.0 的 CHANGELOG
- [b7ba440a](https://github.com/ScottSloan/Bili23-Downloader/commit/b7ba440a5966676523eef3d659a4158e1c0685b3) ♻️ refactor: 抽出共用的 Separator 组件并修复其高度不随布局调整
- [f66d225a](https://github.com/ScottSloan/Bili23-Downloader/commit/f66d225a1dff44b03ce85dfa77d134cb7b92352c) ♻️ refactor: 会员购课程并入课程，并重构命名规则列表
- [9ba82c89](https://github.com/ScottSloan/Bili23-Downloader/commit/9ba82c891b338e02eb415649334b87a9cfdf4aed) 🐛 fix: 来源列表里的影视、课程条目改用各自类型的命名规则
- [d9897b69](https://github.com/ScottSloan/Bili23-Downloader/commit/d9897b69a58f50d7f0448bd674f30e022199a70f) ♻️ refactor: 把入口标签从 {parent_title} 拆成独立的 {source_title}
- [a6b51f17](https://github.com/ScottSloan/Bili23-Downloader/commit/a6b51f172c74af25c3875dcf9cea50c9dc39ab0e) ♻️ refactor: 命名规则迁移改为整表重置，不再逐条比对
- [dc234341](https://github.com/ScottSloan/Bili23-Downloader/commit/dc23434183f9b81ccec4f93a1cc61c51ae1da7b2) ✨ feat: 下载因网络错误失败后自动重新排队重试
- [4b1afd5c](https://github.com/ScottSloan/Bili23-Downloader/commit/4b1afd5c8f965be399666dd3fb33d7602e6ee918) 👷 build: 最低 Python 版本提至 3.11，CI 矩阵移除 macOS
- [7cd2e497](https://github.com/ScottSloan/Bili23-Downloader/commit/7cd2e497d454dc8bbb485beb3b804dbcd3a5a2e4) ✨ feat: 新增隐私政策页面，关于对话框中加入入口
- [46dc5f77](https://github.com/ScottSloan/Bili23-Downloader/commit/46dc5f77bb2e9f80a75329397aa32072f289b9ad) 🐛 fix: 登录态初始化的网络回调改为绑定方法，避免闭包直连引发主线程死锁
- [8ebe8aa5](https://github.com/ScottSloan/Bili23-Downloader/commit/8ebe8aa5d83b68d80194b74e07b6da3d4fdbddaa) 🐛 fix: 命名规则编辑器不再把其它类型专属字段当作推荐变量列出
- [93e1e3ab](https://github.com/ScottSloan/Bili23-Downloader/commit/93e1e3ab3b14479bb104ac18f9d4d2564cdb27c0) ♻️ refactor: 统一使用 _json 进行json操作
- [5babcc4e](https://github.com/ScottSloan/Bili23-Downloader/commit/5babcc4e6cd13fd67e8dd4d315d6ccf99fbcf836) 🐛 fix: 修复 --mcp-stdio 桥接因导入路径错误无法启动
- [f9d38092](https://github.com/ScottSloan/Bili23-Downloader/commit/f9d3809202636b6f485107047ccdaf5bb4bcd217) ♻️ refactor: 重构 _json 统一入口，消除两条实现的行为差异
- [1d309d2f](https://github.com/ScottSloan/Bili23-Downloader/commit/1d309d2f428ff600b2614d10011d5200441526a6) 🐛 fix: 支持解析 bilibili.com/list 播放页链接
- [77a79932](https://github.com/ScottSloan/Bili23-Downloader/commit/77a79932d431a93fb7f3ca3ea6c289b43b5e786e) 🐛 fix: 链接指向的条目落在后续分页时也要定位到
- [d21078b3](https://github.com/ScottSloan/Bili23-Downloader/commit/d21078b3f1c0a16a0e6998adaf93a5da99b65099) 🐛 fix: 下载地址探测不再因时间预算截断候选列表
- [32daaf0d](https://github.com/ScottSloan/Bili23-Downloader/commit/32daaf0d9a683184fc72d5e5d78c1738c09dff20) 🐛 fix: 合并完成的任务进度条不再停在 99%
- [b5e2842e](https://github.com/ScottSloan/Bili23-Downloader/commit/b5e2842ef27e98438393f8e61d65391e5159f8d5) 🐛 fix: 销毁的控件不再收到下一轮事件循环里的延迟回调
- [78bc5c6d](https://github.com/ScottSloan/Bili23-Downloader/commit/78bc5c6dfdb42b818f91a695ae37d4d452e404fd) ✨ feat: 补全 wbi 签名密钥的获取、重试与容错
- [23322f38](https://github.com/ScottSloan/Bili23-Downloader/commit/23322f38efcc8eb2b2dded52c74bd97d04c09ff5) ♻️ refactor: 优化封面缓存机制
- [3002f001](https://github.com/ScottSloan/Bili23-Downloader/commit/3002f001c1ba8cc0da39817571e6d8640d4d6403) 👷 build: 合并 PyStand 启动器源码与内嵌打包脚本
- [0b71723d](https://github.com/ScottSloan/Bili23-Downloader/commit/0b71723da7793a0e9548277e6f6f4fd47f78a58d) 👷 build: Windows 发布改为 CI 现场编译启动器并签名安装程序
- [866e36ec](https://github.com/ScottSloan/Bili23-Downloader/commit/866e36ec172e3832635694548134a997755917ef) 🐛 fix: 构建脚本在英文 Windows 上因输出编码崩溃
- [612a0515](https://github.com/ScottSloan/Bili23-Downloader/commit/612a0515dd4c9c48f963f3265bb8b6feec1238d3) 👷 build: job 使用 signing environment
- [6085af87](https://github.com/ScottSloan/Bili23-Downloader/commit/6085af87f1307072bce8e062b96f099b3e2d858c) feat: 将安装包内嵌的卸载程序纳入签名
- [6f2827ae](https://github.com/ScottSloan/Bili23-Downloader/commit/6f2827ae9bf5e181ee55983062e4f6c97d768823) fix: 修复sign action input参数错误问题
- [1a67322c](https://github.com/ScottSloan/Bili23-Downloader/commit/1a67322c97c6b7c07b897ccc9bf86be740a611c3) Merge pull request #473 from ScottSloan/feat/sign-unstaller
- [3a30d8d7](https://github.com/ScottSloan/Bili23-Downloader/commit/3a30d8d730569182105865314ce7c57fe68603cc) 🐛 fix: 修复下载选项对话框在 Win10 / Linux / macOS 上嵌入主窗口
- [35ac3c96](https://github.com/ScottSloan/Bili23-Downloader/commit/35ac3c96b217bbb9ccb63c2ee3509c5b741e61d9) 🐛 fix: 修复对话框弹出瞬间闪出一个未加样式的空窗口
- [1c25fa40](https://github.com/ScottSloan/Bili23-Downloader/commit/1c25fa40f773cbe8ec6aa2425d783add8007dc3f) ✨ feat: 下载为单个视频前提示不受命名规则约束
- [7fcea089](https://github.com/ScottSloan/Bili23-Downloader/commit/7fcea0896e85a53ce4556d06b29c39e62c1cbd4a) 📝 docs: README 中注明 Windows 启动器来源
- [28a8a519](https://github.com/ScottSloan/Bili23-Downloader/commit/28a8a5195f01f6b69b86a50109dccd11a3aee3ed) 🐛 fix: 修复对话框在 macOS 上顶部出现空白
- [bb91fd60](https://github.com/ScottSloan/Bili23-Downloader/commit/bb91fd60e1ccbde70f66dee580648a38502dfa32) 🐛 fix: 优化部分细节效果
- [740fbe73](https://github.com/ScottSloan/Bili23-Downloader/commit/740fbe732307296037d84caeecb35de2b54a2bbe) ✨ feat: 下载选项中的命名规则卡片提示在设置里修改/新增规则
- [3adfec53](https://github.com/ScottSloan/Bili23-Downloader/commit/3adfec5344d81c3b1ba1d637de9acc929eae9734) ✨ feat: 新增 verhub_sdk
- [ea854aa7](https://github.com/ScottSloan/Bili23-Downloader/commit/ea854aa71a8e9d4dcd923a70f014b797c9c83dbf) ⚡️ perf: macOS 上字体族只保留 PingFang SC，省去查找 Segoe UI 时的别名表构建
- [d980fff9](https://github.com/ScottSloan/Bili23-Downloader/commit/d980fff95e8a2e578e9bcb879a89642f83dce2a6) 👷 build: 更新 CI 构建中的 runtime 版本为 0.1.9
- [e3d6aff3](https://github.com/ScottSloan/Bili23-Downloader/commit/e3d6aff32fffca88b249412b92b40448321418c4) Merge pull request #470 from ScottSloan/refactor/quality-baseline
