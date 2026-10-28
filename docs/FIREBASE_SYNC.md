# LunaTOC 云同步：维护者统一 Firebase

## 用户侧流程

LunaTOC 由维护者统一管理 Firebase 项目。普通用户不需要创建 Firebase 项目、注册 LunaTOC 同步账号、输入邮箱密码、填写 API Key 或部署安全规则。

- 扩展默认只在本地运行，不上传用户数据。
- 设置页只有一个“自动云同步”开关。
- 用户主动开启时，扩展请求 Firebase 网络权限，并通过 Chrome Identity 使用现有 Google 账号授权。Firebase 自动查找或建立该 Google 身份对应的认证记录；用户不需要创建 LunaTOC 账号。
- 开启成功前，扩展先验证当前已登录的 ChatGPT 账号并完成一次真实同步。验证失败时开关保持关闭。
- 开启后，本地 Tips、目录别名、主题与侧边栏偏好发生变化时自动尝试同步；打开或切换 ChatGPT 标签页时也会尝试同步当前可验证的账号。
- 关闭开关会停止自动同步并清除本次 Firebase 会话，不删除本地数据，也不会自动删除云端副本。
- 多设备必须使用同一个 Google 账号，并在每台设备上开启同步；每台设备还需登录要同步的 ChatGPT 账号。一个 Google 账号下的不同 ChatGPT 账号仍然分开存储。
- 网络故障、权限拒绝、数据冲突或配额问题不会以“同步成功”处理，也不得删除本地数据。此功能不是端到端加密。

## 维护者首次上线配置

1. 在 Firebase 控制台创建 LunaTOC 维护者拥有的项目，选择 Spark 免费方案起步，并创建默认 Cloud Firestore。
2. 在 Authentication → Sign-in method 中启用 **Google** 提供方。用户无需使用 Email/Password 提供方。
3. 在 Google Cloud Console 为 Chrome 扩展创建 OAuth Client ID，并绑定正式扩展 ID。开发测试时也要把正在测试的扩展 ID 配置正确；未固定扩展 ID 的临时 unpacked 扩展可能需要单独的测试 OAuth 客户端。
4. 在仓库根目录 [firestore.rules](../firestore.rules) 中使用官方安全规则，并将完整规则发布到生产 Firestore。
5. 在 Firebase Web App 设置中取得公开的 Project ID 和 Web API Key。它们是客户端配置，不是服务账号密钥；不要把 Firebase Admin SDK 私钥加入仓库。
6. 在 GitHub 仓库 Settings → Secrets and variables → Actions → Variables 添加三个公开配置：
   - `LUNATOC_FIREBASE_PROJECT_ID`：官方 Firebase 项目 ID。
   - `LUNATOC_FIREBASE_WEB_API_KEY`：Firebase Web API Key。
   - `LUNATOC_GOOGLE_OAUTH_CLIENT_ID`：为 Chrome 扩展创建的 Google OAuth Client ID。
7. CI 在构建时将这些变量嵌入扩展。没有全部配置时，云同步保持不可用；main 发布门禁会阻止不完整配置的版本。
8. 维护者在真实 Chrome 中完成 Google 授权、Firebase Auth、Firestore 读写、双设备同步和账号隔离测试后，才可合并发布 PR。

OAuth Client ID 是公开标识符，不是私钥。不要将 OAuth 客户端密钥、服务账号 JSON 或管理员凭据放进扩展。

## 自动化测试

CI 的 Firebase 规则作业会使用 Firebase 官方 Firestore 模拟器加载同一份 `firestore.rules`，验证：

- Firebase UID A 只能访问自己的合法快照；UID B 和匿名身份不能读取或改写 A 的文档。
- 任何身份不能列举账户集合或删除文档。
- 非法账户哈希、额外字段、非字符串字段、超长快照及其他路径均被拒绝。
- Vitest 测试覆盖 Google 身份令牌交换、同步快照校验、账号隔离、冲突保护、离线失败和关闭同步后保留本地数据。

本地运行 Firestore 规则测试需要 Node.js 22、Java 21 和网络下载 npm 包及模拟器：

    npm --prefix test/firebase install --no-package-lock
    test/firebase/node_modules/.bin/firebase emulators:exec --only firestore --project demo-lunatoc-ci "node --test test/firebase/firestore.rules.test.mjs"

模拟器不能证明生产项目已启用 Google 提供方、绑定了正确的 OAuth Client ID 或发布了相同规则。真实环境验收仍然是发布阻断条件。

## 数据与隐私

云端路径为 `users/{firebaseUid}/accounts/acct_{sha256(chatgptOwnerId)}`。Firebase UID 按 Google 身份稳定区分用户，ChatGPT 账号 ID 的摘要用于分组。每份快照限 240 KB，使用 Firestore 条件写入、基线三方合并和本地回滚。同步失败时保留本地数据，遇到数据冲突停止覆盖。

**隐私提醒：** Firebase 项目由 LunaTOC 维护者托管，维护者可能在其 Firebase 数据库查看用户主动上传的明文 Tips 内容与目录名称。这不是端到端加密。用户不想上传私人内容，可关闭同步并继续本地使用；关闭同步不会自动删除已存在的云端副本。

## Spark 免费额度

标准 Cloud Firestore 可适用 Spark 免费额度，但统一项目会汇聚所有用户的用量。维护者必须监控用量与滥用，不能保证用户增长后永远免费，也不能让客户端持有服务账号密钥或开放安全规则。
