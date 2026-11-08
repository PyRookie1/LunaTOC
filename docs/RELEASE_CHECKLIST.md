# LunaTOC 1.0.2 发布验收清单

> 模拟器和 CI 的成功只验证开发环境；生产 Firebase 和真实浏览器仍是独立阻断条件。

## 自动化门槛

- [x] Node.js 22 锁定依赖安装、类型检查、完整 Vitest 测试通过。
- [x] 初始版本源码卫生检查通过：无旧项目名称、旧存储键、迁移流程或旧 Bug 编号。
- [x] Manifest MV3、版本号、扩展 ZIP 完整性、Chromium E2E、依赖安全审计通过。
- [x] Firebase Emulator 实际加载仓库的 firestore.rules，并验证双 UID、匿名访问、越权、异常文档。
- [x] 邮箱＋密码注册/登录、邮箱验证、错误密码、未验证邮箱访问拒绝和失败保护的自动测试通过。
- [x] main 发布门禁核对 Project ID、Web API Key 和 Firebase Hosting authDomain 三项公开 GitHub Variables。
- [x] 集成分支、main 的相应 CI 全部通过，ZIP Artifact 名称为 `lunatoc-v1.0.2`，内容包含 `lunatoc-v1.0.2.zip` 及对应 SHA-256 文件。

## 删除标记安全边界

- [x] 云端三类删除标记分别受 20,000 条上限约束，快照受 240 KB 上限约束；本地提示词删除标记受每账号 20,000 条上限约束。
- [x] 达到上限时写入/同步失败并保留现有数据，不会自动丢弃旧删除标记。
- [x] 不执行基于 TTL 的删除标记清理；任何未来压缩必须先具备设备确认与过期/撤销协议。

## 服务端写入配额（阻断发布）

- [x] 所有账号快照写入必须使用 Firestore `documents:commit`，快照和 UID 配额文档在同一原子提交中更新。
- [x] Firestore Emulator 验证：绕过客户端直接 PATCH/写账号文档被拒绝；只写配额文档被拒绝；UID、邮箱验证和账号隔离仍有效。
- [x] Firestore Emulator 验证：同一 UID 的 5 秒写入冷却、固定 24 小时窗口 100 次上限、过期后服务器时间重置。
- [x] Firestore Emulator 验证：每个 UID 最多注册 20 个 ChatGPT 账号快照；第 21 个注册被拒绝且既有快照保留。
- [x] 验证两个设备同时写入时，账号文档和共享配额文档的更新时间前提冲突会触发重读/重试，不丢失数据、不重复扣额度。
- [x] 确认无变化同步不消耗写入配额；达到频率/每日上限时本地数据和同步基线不变。
- [x] 新版客户端与新版 `firestore.rules` 一起发布；不得先单独部署规则或让旧版客户端继续写入。
- [x] 核算每次同步增加的配额文档读写与 Security Rules 文档访问成本，确认 Spark 用量预算；不得自动升级 Blaze。

## 云端数据初始化与管理（阻断发布）

- [x] 客户端统一使用 `users/{uid}/accounts/{accountHash}` 和 `users/{uid}/usage/cloudWrites`，无并行集合或迁移分支。
- [x] 账号文档只包含 `json`；快照和配额文档均不包含数据版本字段；字段、类型和范围由 Firestore Rules 强制校验。
- [x] 初始化时仅清除本地同步基线元数据；提示词、目录、设置和删除标记保持不变。
- [x] Firestore Emulator 验证原子快照/配额写入、UID 隔离、邮箱验证、5 秒冷却、24 小时 100 次上限、20 个 ChatGPT 账号上限和 240 KB 快照限制。
- [x] `node --test test/firebase/firestore-reset.test.mjs` 通过；覆盖只读盘点、项目/人工确认、分页、updateTime 前提、部分失败复盘和报告文件预留。
- [x] Firestore Emulator 集成测试通过：清库只删除规范账号快照与配额文档，其他 Firestore 文档保留；清理后重新盘点为零。
- [x] 生产清库前核对 Firebase Project ID 和目标 Firestore 数据库；执行时必须使用管理员 ADC、显式 `--execute`、项目 ID 二次确认及完整人工确认短语。
- [x] 清理后重新盘点业务文档为零；Firebase Authentication 用户和 Chrome 本地数据保留。
- [x] 部署统一 Firestore Rules 后，完成真实注册、邮箱验证、双设备同步、冲突、删除传播和本地恢复验收。

## 真实 Firebase（阻断发布）

- [x] 维护者 Firebase 项目启用 **Email/Password**，关闭 Email link (passwordless)；Google OAuth 客户端不是必要条件。
- [x] 已注册 Firebase Web App，使用其真实 `authDomain`，确认在 Authentication 授权域名中。
- [x] 已在生产默认 Firestore 发布仓库的 firestore.rules；用户 A、B、匿名隔离校验通过。
- [x] 使用真实邮箱注册密码账号 → 收到地址验证邮件并点击 → 返回设置页核验 → Firestore 首次上传；验证前 Firestore 应拒绝访问。
- [x] 两台 Chrome 配置文件使用**相同的 LunaTOC 邮箱＋密码**和**相同 ChatGPT 账号**，分别确认本机绑定后验证自动上传/下载；不同 ChatGPT 账号互不覆盖。
- [x] 同一浏览器保留 ChatGPT A/B，本机仅绑定 A 到 Firebase UID 1；登录 UID 2 时既不自动上传 A，也不上传未绑定的 B。重新绑定需明确解除旧绑定并再次确认。
- [x] 两设备分别修改主题和布局字段可合并；同一字段发生不同更改、删除与修改冲突时停止同步并保留数据。
- [x] 验证浏览器重启后自动同步、关闭后停止上传并清除本地凭据。
- [x] 验证 Chrome MV3 Worker 休眠、网络恢复后的持久化重试，及每 60 分钟云端轮询；核对 Firestore 配额影响。
- [x] 验证错误密码、邮箱未验证、令牌失效、离线、权限拒绝、远端文档缺失、冲突和配额问题时不会静默删除本地数据。
- [x] 核对 Firestore 用量、文档大小、Firebase 计费与隐私说明。
- [x] **确认密码方案的免费额度**：邮件链接登录已删除，真实注册验证邮件每天 1,000 封、密码重置每天 150 封；监控使用量，不得自动升级付费 Blaze。

## 真实 ChatGPT 与发布

- [x] 真实 Chrome 下的目录、搜索、跳转、回答标题、Markdown 粗体修复与账号隔离正常。
- [x] 本地备份导出、合并、覆盖与失败回滚正常。
- [x] 确认 Manifest 权限仅包含必要的 storage、webRequest、alarms，Firebase 主机权限在用户启用同步后才请求。
- [x] 核对 README、PRIVACY、CHANGELOG、LICENSE 和第三方许可。
- [x] 仅在所有真实环境验收通过后，合并 PR 至 main，重新验证 main CI 并发布 1.0.2。

以上自动化、真实 Firebase 生产环境、双设备同步及真实浏览器验收项目均已由维护者确认通过；CI 模拟结果与生产环境验收分别记录。
