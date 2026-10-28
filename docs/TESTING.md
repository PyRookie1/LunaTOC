# 测试与验收

## 本地检查

在 Node.js 22 环境中运行：

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:browser:setup
npm run test:browser
npm audit --audit-level=high
```

## 自动化覆盖范围

- **类型检查**：检查应用代码和构建脚本的 TypeScript 类型。
- **单元测试**：验证目录导航、账号隔离、本地存储、备份恢复、主题布局和 Markdown 粗体修复等行为。
- **扩展构建检查**：验证 Manifest V3 配置以及引用的构建文件。
- **浏览器测试**：在隔离的 Chromium 环境中加载构建产物，并使用本地模拟页面检查主要流程。
- **依赖安全检查**：检查依赖树中的高危及以上级别安全公告。
- **Firebase 模拟器安全规则测试**：独立 CI 作业启动 Firestore Emulator，加载实际 firestore.rules，使用 A/B/匿名身份验证跨用户隔离和拒绝列表、删除及异常数据写入。
- **发布配置门禁**：以 main 为目标的发布 PR / main 推送需具备维护者提供的 Firebase 公开项目配置，未配置即 CI 失败。

浏览器测试使用模拟页面，不会验证真实登录账号下的 ChatGPT 线上行为。真实网站兼容性仍需在对应功能完成后单独验收。

核心功能具体行为与验收规则见 [核心功能验收](CORE_FEATURES.md)。

账号身份、隔离和写入规则见 [账号身份与本地数据隔离](ACCOUNT_DATA.md)。

最终 1.0.0 发布还需要真实 ChatGPT 账号和 Firebase Spark 项目的手工验证，见 [发布验收清单](RELEASE_CHECKLIST.md)。

## 分阶段开发规则

每个阶段的测试应与该阶段承诺的功能一起加入。当前阶段必须通过已经实现功能的测试、类型检查和构建检查；后续阶段尚未加入的功能，不应成为当前阶段的必需测试。新增功能合入后，其测试成为后续阶段的持续检查。

