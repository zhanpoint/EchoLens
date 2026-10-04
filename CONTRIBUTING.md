# 参与贡献

欢迎改进 EchoLens 的解析、转录、AI 处理、采集与工具集成。参与前请阅读 [非商业许可](LICENSE.md) 和 [README 配置说明](README.md#配置)。

## 开发流程

1. Fork 仓库，按 README 配置本地服务。
2. 从最新 `master` 创建用途明确的分支，例如 `fix/batch-pagination`。
3. 沿用现有组件、平台客户端、任务队列和存储接口。重构时同步删除失效逻辑，避免重复实现。
4. 为行为变化补充有价值的回归测试，说明复现条件和验证结果。
5. 提交 Pull Request；标题描述最终变化，正文写清问题、结果和验证边界。

```powershell
git switch master
git pull --ff-only
git switch -c fix/batch-pagination
npm run typecheck
npm run lint
npm test
npm run build
```

## 数据库与界面验证

默认测试使用隔离的模拟数据。真实数据库测试需要本机 PostgreSQL 与 `.env` 中具有创建数据库权限的账号；它会创建并清理独立临时数据库，不修改业务表。

```powershell
$env:BATCH_POSTGRES_TEST = '1'
npm test
Remove-Item Env:BATCH_POSTGRES_TEST
```

界面变化应验证桌面与手机宽度、键盘操作、加载／空／失败状态、暂停和重试。使用接口夹具展示和验证界面，真实服务调用需有明确授权，避免重复提交付费识别。

## 提交前

- 不提交 `.env`、API Key、Cookie、验证码、浏览器配置目录和用户数据。
- 不以增加模糊兜底掩盖上游协议、状态机或数据结构的问题。
- 行为或配置改变时同步更新相关文档。
- 项目使用持续运行的 Node 服务。`master` 推送可能触发生产部署，普通贡献请通过 PR 进入。

## 报告问题

通过 [Issues](https://github.com/zhanpoint/EchoLens/issues) 提供平台、操作步骤、预期行为、实际行为和已脱敏的错误。凭据或私人数据问题请勿附在公开 Issue 中。
