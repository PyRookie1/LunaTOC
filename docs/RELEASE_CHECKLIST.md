# LunaTOC 1.0.0 发布验收清单

> CI 通过只证明构建、模拟页面和测试替身下的功能正常。要合并到 main 并正式发布，还须完成下列真实环境验收。

## 自动化门槛

- [ ] 依赖锁定安装成功（Node.js 22，npm ci）
- [ ] 版本一致（package.json、package-lock.json、manifest.json 均为 1.0.0）
- [ ] TypeScript 类型检查、全部 Vitest 测试通过
- [ ] 扩展打包、Manifest V3 引用文件检查通过
- [ ] Chromium 本地模拟 ChatGPT 功能测试通过
- [ ] npm audit --audit-level=high 无阻断问题
- [ ] Firebase 模拟器加载实际 firestore.rules，验证 A/B/匿名用户隔离与写入格式
- [ ] 发布门禁检查 Firebase Project ID、Web API Key 和 Google OAuth Client ID 均已配置
- [ ] 集成分支合并后，目标分支 CI 再次通过

## 真实 ChatGPT 账号与浏览器

- [ ] 在实际 Chrome 中加载扩展，验证目录、回答标题、跳转、搜索和 Markdown 粗体修复。
- [ ] 至少测试两个不同的 ChatGPT 测试账号：Tips、目录别名、主题与布局互相隔离；切换账号时不显示或写入错误账号的数据。
- [ ] 验证本地备份导出、合并恢复、覆盖恢复、失败回滚。

## 真实 Firebase 项目（阻断发布）

- [ ] 在维护者拥有的 Firebase 项目中启用 Google Authentication 和默认 Cloud Firestore，并部署仓库的 firestore.rules。
- [ ] Google OAuth Client ID 与待发布的 Chrome 扩展 ID 匹配；扩展通过 Chrome Identity 成功获取 Google 访问令牌。
- [ ] 两个不同 Firebase UID 之间无法读取、修改或列出对方的文档；匿名访问和非法路径被拒绝。
- [ ] 在两台设备或隔离的 Chrome 配置文件上使用同一 Google 账号并开启同步：新增 Tips、修改目录别名和偏好后，另一台设备能自动取得变更。
- [ ] 在同一 Google 身份下测试两个 ChatGPT 账号，确认数据互不读取或覆盖。
- [ ] 验证关闭云同步后停止上传且保留本地数据；验证断网、规则拒绝、并发冲突、远端文档意外缺失和配额异常时不会静默丢失本地数据。
- [ ] 检查 Firebase 用量、文档大小限制与项目权限，确认没有意外账单或开放规则。

## 发布

- [ ] 核对 README、PRIVACY、CHANGELOG、LICENSE、第三方许可和云同步说明。
- [ ] 项目拥有者确认真实环境验收结果后，才提交集成分支 → main 的正式合并 PR。
- [ ] main 分支 CI 全绿，从 main 构建 1.0.0 ZIP；核对版本、权限和发布产物后再发布。
- [ ] 不得忽略失败测试，也不得凭 CI 通过宣称真实 Firebase 权限已经验证。

## 当前未完成的外部前提

正式上线前仍需维护者启用 Google Authentication、创建并绑定 OAuth Client ID、部署 Firestore 规则、配置三个 GitHub Actions Variables，并完成真实双设备测试。模拟器和格式门禁不能替代这些真实环境检查。参见 [Firebase 同步操作说明](FIREBASE_SYNC.md)。
