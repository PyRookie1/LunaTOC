# LunaTOC 云同步：维护者统一 Firebase（方案 B）

## 使用者无需配置 Firebase

LunaTOC 由维护者提供统一的 Firebase 项目。普通用户不需要创建项目、填写 API Key、修改 Firestore Rules 或理解云端基础设施。

- 安装扩展后，所有目录、Tips、外观和备份功能默认只在本地运行。
- 维护者已上线 Firebase 服务时，设置页提供“登录 / 注册同步账号”，用户明确选择后才会请求额外 Firebase 网络权限。
- 用户使用自己的同步邮箱、密码登录，选定已验证的 ChatGPT 账号，按“立即同步”上传或下载 Tips、目录别名和偏好。
- Firebase 同步账号与 ChatGPT 账号相互独立。跨设备需要相同的 Firebase 同步账号和相同的 ChatGPT 账号。
- 未配置、离线或 Firebase 失败时，不影响本地目录、提示词、布局和备份；不会自动上传聊天正文或使用统计。
- 目前是手动同步，不提供后台持续轮询、自动冲突解决或端到端加密。请保管敏感提示词。

## 维护者首次上线配置（只需维护者完成）

1. 在 Firebase 控制台创建 LunaTOC 所有的项目（可先选择 Spark 方案）。在 Authentication 启用 Email/Password 登录，并创建默认 Cloud Firestore。
2. 在 Firestore 中部署仓库根目录 [firestore.rules](../firestore.rules)。规则只允许已认证 Firebase UID 读取/修改自身的账户文档；禁止列举、删除、跨 UID 访问和非预期结构写入。
3. 在项目 Web App 设置中获取公开的 Project ID、Web API Key。它们是客户端标识符，不是服务账号密钥；不要在仓库中加入 Firebase Admin SDK 私钥。
4. 在 GitHub 仓库 Settings → Secrets and variables → Actions → Variables 添加：
   - LUNATOC_FIREBASE_PROJECT_ID：官方 Firebase 项目 ID。
   - LUNATOC_FIREBASE_WEB_API_KEY：官方 Firebase Web API Key。
5. CI 用这两个变量在 Vite 构建时嵌入官方项目配置。代码不再接受用户自带项目地址，也不会相信遗留的本地项目配置存储键。
6. main 和所有以 main 为目标的 PR 自动运行 release-config 门禁；没有有效的公开 Firebase 配置将失败，防止误发不可用的云同步版本。
7. 配置项目后，维护者用独立测试账号执行一次真正的 Firebase Auth + Firestore 联调、真实 Chrome/ChatGPT 冒烟测试，确认已部署规则一致，才可以将发布 PR 合并到 main。公开配置的格式检查不是实际联调。

## 无账号、无生产凭据的自动测试

CI 的 firebase-rules 作业使用 Firebase 官方 Firestore 模拟器实际加载同一份 firestore.rules，而非只模拟成功响应，验证：

- Firebase UID A 仅能读写自己的合法快照；UID B 和匿名身份不能读取、改写或删除 A 的文档。
- 任何身份不能列举账户集合或删除文档。
- 非法账户哈希、额外字段、非字符串字段、超长快照及其他路径均被拒绝。

本地运行需要 Node.js 22、Java 21 和网络下载 npm 包及模拟器。

    npm --prefix test/firebase install --no-package-lock
    test/firebase/node_modules/.bin/firebase emulators:exec --only firestore --project demo-lunatoc-ci "node --test test/firebase/firestore.rules.test.mjs"

原项目的 Vitest 测试还验证双设备隔离存储、Firebase REST 协调、登录、离线、权限拒绝与合并逻辑。但模拟器不能证明生产环境已部署规则；仍需维护者发布前联调。

## 数据与隐私

云端路径为 users/{firebaseUid}/accounts/acct_{sha256(chatgptOwnerId)}。数据库按 Firebase UID 进行隔离；扩展还要求目标 ChatGPT 标签页重新验证真实会话身份。Firebase 登录凭据只保留在 Chrome 会话存储，密码不会持久化。每份快照限 240 KB，使用 Firestore 条件写入、基线三方合并和本地回滚。同步失败时保留本地数据，遇到数据冲突停止覆盖。

**隐私提醒：** Firebase 项目由 LunaTOC 维护者托管，维护者可能在其 Firebase 数据库查看用户主动上传的明文 Tips 内容与目录名称。这不是端到端加密。用户不想上传私人内容，可关闭同步并继续本地使用；需要时可导出本地备份。

## Spark 额度

标准 Cloud Firestore 可适用 Spark 免费额度，但统一项目会汇聚所有用户的用量。维护者必须监控用量与滥用，不能保证增长后永远免费，也不能让客户端持有服务账号密钥或开放安全规则。
