# LunaTOC 1.0.0 发布验收清单

> CI 通过只证明构建、模拟页面和测试替身下的功能正常。要合并到 main 并正式发布，还须完成下列**真实环境**验收。不得用模拟 Firebase 请求代替真实 Firestore 安全规则验收。

## 自动化门槛

- [ ] 依赖锁定安装成功（Node.js 22，npm ci）
- [ ] 版本一致（package.json、package-lock.json、manifest.json 均为 1.0.0）
- [ ] TypeScript 类型检查、全部 Vitest 测试通过
- [ ] 扩展打包、Manifest V3 引用文件检查通过
- [ ] Chromium 本地模拟 ChatGPT 功能测试通过
- [ ] npm audit --audit-level=high 无阻断问题
- [ ] 集成分支（rebuild/lunatoc-1.0.0）合并后 CI 再次通过

## 真实 ChatGPT 账号与浏览器

- [ ] 在实际 Chrome 中加载扩展，打开已登录 ChatGPT 网站；目录、回答标题、跳转、搜索和 Markdown 粗体修复正常。
- [ ] 至少测试两个**不同**的 ChatGPT 测试账号：Tips、目录别名、主题与布局相互隔离；登录状态过期或切换账号时不出现上一账号的数据，也不允许写入。
- [ ] 验证本地备份导出、合并恢复、覆盖恢复、失败回滚；保留导出文件并谨慎使用私有数据。

## 真实 Firebase 项目（阻断发布）

- [ ] 在**用户持有**的 Firebase Spark 测试项目启用 Email/Password + 默认 Cloud Firestore，并部署 firestore.rules。
- [ ] 使用两个不同 Firebase 测试 UID 验证 Firestore 安全规则：UID A 只可访问自己的账户文档；UID B 无法读取、修改或列出 UID A 的文档；匿名访问和非法路径均被拒绝。
- [ ] 在两台设备或相互隔离的 Chrome 用户配置下，以相同 Firebase UID 和同一个 ChatGPT 测试账号测试：新增 Tips、编辑目录别名、修改偏好、手动同步、第二台设备读取。
- [ ] 验证同一个 Firebase UID 下的两个 ChatGPT 账号互不读取或覆盖对方内容。
- [ ] 验证删除、双设备并发冲突、远端文档意外消失、网络掉线、权限拒绝和配额异常：均不能静默丢失原始本地数据；必要时用备份恢复。
- [ ] 退出 Firebase 后不上传；浏览器重启后新会话需重新登录；核实扩展的默认本地功能不要求 Firebase 主机权限。
- [ ] 检查 Firebase 使用量和 Firestore 文档大小限制，确认没有产生意外账单或错误的项目权限。

## 发布

- [ ] 核对 README、PRIVACY、CHANGELOG、LICENSE、第三方许可和云同步配置说明。
- [ ] 项目拥有者确认真实环境验收结果；只在以上检查全部完成后，提交集成分支 → main 的正式合并 PR。
- [ ] main 分支 CI 全绿，最后从 main 构建 1.0.0 可分发 ZIP；核对版本和权限后发布 GitHub Release/Chrome Web Store（如适用）。
- [ ] 未通过的测试不得忽略；不要凭 CI 通过宣称真实 Firebase 权限已验证。

## 当前未完成的外部前提

仓库不包含 Firebase 管理员凭据、可公开的测试账号或可自动部署的真实 Firebase 项目，因此无法在 GitHub Actions 中对用户的实际 Firebase 配置执行上述跨账号安全与双设备联调。此项需项目拥有者在测试环境中执行并记录结果，再决定是否发布。参见 [Firebase 同步操作说明](FIREBASE_SYNC.md)。
