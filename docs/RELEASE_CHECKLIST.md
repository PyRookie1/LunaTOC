# LunaTOC 1.0.0 发布验收清单

> 模拟器和 CI 的成功只验证开发环境；生产 Firebase 和真实浏览器仍是独立阻断条件。

## 自动化门槛

- [ ] Node.js 22 锁定依赖安装、类型检查、完整 Vitest 测试通过。
- [ ] 初始版本源码卫生检查通过：无旧项目名称、旧存储键、迁移流程或旧 Bug 编号。
- [ ] Manifest MV3、版本号、扩展 ZIP 完整性、Chromium E2E、依赖安全审计通过。
- [ ] Firebase Emulator 实际加载仓库的 firestore.rules，并验证双 UID、匿名访问、越权、异常文档。
- [ ] 邮箱＋密码注册/登录、邮箱验证、错误密码、未验证邮箱访问拒绝和失败保护的自动测试通过。
- [ ] main 发布门禁核对 Project ID、Web API Key 和 Firebase Hosting authDomain 三项公开 GitHub Variables。
- [ ] 集成分支、main 的相应 CI 全部通过。

## 真实 Firebase（阻断发布）

- [ ] 维护者 Firebase 项目启用 **Email/Password**，关闭 Email link (passwordless)；Google OAuth 客户端不是必要条件。
- [ ] 已注册 Firebase Web App，使用其真实 `authDomain`，确认在 Authentication 授权域名中。
- [ ] 已在生产默认 Firestore 发布仓库的 firestore.rules；用户 A、B、匿名隔离校验通过。
- [ ] 使用真实邮箱注册密码账号 → 收到地址验证邮件并点击 → 返回设置页核验 → Firestore 首次上传；验证前 Firestore 应拒绝访问。
- [ ] 两台 Chrome 配置文件使用**相同的 LunaTOC 邮箱＋密码**和**相同 ChatGPT 账号**，验证自动上传/下载；不同 ChatGPT 账号互不覆盖。
- [ ] 验证浏览器重启后自动同步、关闭后停止上传并清除本地凭据。
- [ ] 验证 Chrome MV3 Worker 休眠、网络恢复后的持久化重试，及每 60 分钟云端轮询；核对 Firestore 配额影响。
- [ ] 验证错误密码、邮箱未验证、令牌失效、离线、权限拒绝、远端文档缺失、冲突和配额问题时不会静默删除本地数据。
- [ ] 核对 Firestore 用量、文档大小、Firebase 计费与隐私说明。
- [ ] **确认密码方案的免费额度**：邮件链接登录已删除，真实注册验证邮件每天 1,000 封、密码重置每天 150 封；监控使用量，不得自动升级付费 Blaze。

## 真实 ChatGPT 与发布

- [ ] 真实 Chrome 下的目录、搜索、跳转、回答标题、Markdown 粗体修复与账号隔离正常。
- [ ] 本地备份导出、合并、覆盖与失败回滚正常。
- [ ] 确认 Manifest 权限仅包含必要的 storage、webRequest、alarms，Firebase 主机权限在用户启用同步后才请求。
- [ ] 核对 README、PRIVACY、CHANGELOG、LICENSE 和第三方许可。
- [ ] 仅在所有真实环境验收通过后，合并 PR 至 main，重新验证 main CI 并发布 1.0.0。

目前仍缺外部真实 Firebase 邮箱＋密码注册及双设备验证，不能把 CI 模拟结果当作生产验证。
