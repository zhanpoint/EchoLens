# 抖音 11 个新增提交与 EchoLens 链路对照

日期：2026-10-03。参考仓库：jiji262/douyin-downloader，范围 `203c1ae0..9874f413`，共 11 个提交。两个参考仓库保持独立。

此文记录较早一次提交对照，下面的手动 msToken 路径已被后续实网修复替代。当前全部凭证接口统一使用网页 SDK；旧签名、msToken 生成器及配置快照已删除。当前机制和实测边界见 [请求修复记录](./douyin-request-fix-2026-10-03.md)。

## 逐项结论

| 提交 | 源码变化 | EchoLens 对照及决定 |
| --- | --- | --- |
| `256f9110` | msToken 生成时限从 15 秒缩至 3 秒；跨实例单飞；成功缓存 60 秒、失败冷却 300 秒；凭证和 User-Agent 区分作用域 | 原配置 fetch 没有超时；原 pendingToken 全局且仅覆盖并发，顺序请求重复生成。采用作用域 Promise 缓存、短期复用与失败冷却；配置请求和 token POST 各最多 3 秒，计时覆盖配置 body 读取，两步最多约 6 秒 |
| `9b3b6f1f` | 收藏夹优先 collects_id_str，避免 int64 经 JS 丢精度 | favorites.ts 的 readIdentifier 已优先读取字符串，并仅接受安全整数；包括嵌套 collects_info 的字符串。不修改 |
| `1f540317` | GitHub 配置不可达时使用上次配置或内置公开快照 | 采用其公开配置快照；远程有效配置优先，刷新失败使用上次成功配置，再使用快照。配置单飞及 300 秒失败冷却；不复制 Python 实现 |
| `fae033f9` | Argus 门禁改走桌面页面桥接；作者主页分页重试与不完整结果；收藏不排除作者置顶 | EchoLens 是服务器端 HTTP 客户端，无登录窗口内的页面桥接，无作者主页批量分页业务；收藏本就不按 is_top 排除。保留真实 403 错误和已有公开分享页路径，不伪造桥接，不叠加主页重试层 |
| `26b2eb2e` | 作品详情失败原因写入 DownloadResult | EchoLens 已有 DouyinMetadataError、缺失字段提示和 cause；不用新增桌面 DownloadResult 状态模型 |
| `5a4ce0dc` | 分页区别正常空页与接口失败；条目原因回传；确定性 Argus 拒绝不重试 | EchoLens 的 HTTP/登录错误已抛异常，但 HTTP 200 非零 status_code 原样放行，可被下游归一化为空列表。统一 Web 客户端在登录识别后抛带 upstreamCode 的业务错误；不在各分页函数堆积判断，不引入错误字符串匹配或桌面事件模型 |
| `125ddf4d` | 作者主页合集合并 mix/list 和 series/list，并保留来源失败 | EchoLens 当前获取的是账号收藏合集 mix/listcollection，而不是作者主页合集。两者业务语义不同，不调用 series/list 混入账号收藏 |
| `d50a5a44` | 队列运行时调整并发；一次重试内固定 max_retries，避免设置变动打断退避 | 当前媒体队列上限由进程环境配置固定，未提供运行时修改；retryOperation/fetchWithRetry 的 attempts、退避基数和上限在进入循环前已固定。不新增动态队列 |
| `47f4eef8` | 文件名保留合法 #、连续空格/下划线；转写复用下载清洗 | EchoLens 的 sanitizeDownloadPathSegment 已保留这些合法字符；按 Windows 非法字符替换。Python 本地 Whisper 文件名函数没有迁移对象。不修改 |
| `f7ec48f9` | 仅更换 img/fuye.jpg | 与抖音运行链路无关，不迁移 |
| `9874f413` | README 精简、截图与交流群更新 | 与抖音运行链路无关，不迁移 |

## 最终变更与约束

- 生产代码仅改 `ms-token.ts`、`web-client.ts`，新增实际用于配置失败恢复的 `ms-token-config.json`；不修改业务接口、列表返回结构或新增长期存储。
- msToken 的 Cookie 值仍直接优先使用；仅缺少 token 时生成。内存缓存 key 为凭证与 User-Agent 的 SHA-256 指纹，不存储原 Cookie；在下一次访问时删除已过期 entry。
- 同作用域并发共享一个 Promise；不同作用域生成隔离，仅公开配置共享。成功缓存 60 秒，生成失败后同作用域复用随机 token 300 秒，再尝试生成。
- 超时 AbortController 计时器在 finally 清理；配置计时覆盖 fetch 与 response.text。依赖 fetch 的标准 AbortSignal 取消契约，不创建无法取消的超时竞争后台请求。
- 配置快照逐字段提取自上游 auth/ms_token_conf.py，不编造参数。它是上游 2026-09-06 的公开生成配置，不能保证平台持续接受；真实生成不可用时保留原随机 token 行为，冷却后重试。
- 业务失败统一抛 DouyinApiError，带 endpoint、HTTP status、upstreamCode；登录错误仍沿用现有独立处理。正常空列表和无 status_code 的已有兼容响应保持原行为。
- 不声称解决 Argus 门禁，也不把生成真实 token 等同于可通过平台安全验证。

## 依据

- 本地参考源码及差异：`auth/ms_token_manager.py`、`auth/ms_token_conf.py`、`core/api_client.py`、`core/user_modes/base_strategy.py`、`core/user_modes/post_strategy.py`、`core/item_reasons.py`、`control/queue_manager.py`、`control/retry_handler.py`、`utils/validators.py`，以及对应回归测试。
- 上游认证配置提交：[1f540317](https://github.com/jiji262/douyin-downloader/commit/1f540317)。该快照本身引用 F2 的公开配置，不是账号凭证。
- Node.js 22 官方 [AbortController 文档](https://nodejs.org/docs/latest-v22.x/api/globals.html#class-abortcontroller)说明取消信号和一次性 abort 事件；通过官方页面核对实现依据。

## 验证

全量 Vitest：70 个文件通过，383 个测试通过，1 个条件式 Bili 实网测试跳过。typecheck 与 lint 通过。npm run build 成功，包含 TypeScript 和全部路由生成，无新增构建警告。新增 9 个回归覆盖配置 body 停滞、两阶段超时、单飞/作用域隔离、成功 TTL、失败冷却、内置/旧配置恢复、HTTP 200 业务错误及收藏后续页失败。快照逐字段与上游 Python 源码一致。没有使用真实用户 Cookie 或进行线上抖音安全验证。

## 配置快照来源许可证

ms-token-config.json 来源于 jiji262/douyin-downloader 的上述配置文件。保留其 MIT 许可证声明如下：

```text
MIT License

Copyright (c) 2026 jiji262

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
