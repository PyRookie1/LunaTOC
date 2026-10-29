# LunaTOC 邮件链接自动云同步（维护者统一 Firebase）

## 用户流程

1. 安装 LunaTOC，默认所有数据仅保存在本地。
2. 在已登录 ChatGPT 的页面中打开 LunaTOC 设置，开启“自动云同步”。
3. 输入用于跨设备同步的邮箱，点击“发送验证邮件”。**不需要注册 LunaTOC 账号或设置密码**。
4. 从邮件中复制**完整的登录链接**，返回扩展设置页粘贴并确认。不要转发链接，也不要先在网页中点击消耗一次性代码。
5. 完成身份验证后，扩展先验证当前 ChatGPT 账号并尝试首次同步；成功后自动同步开关正式开启。
6. 在另一台设备使用相同邮箱重复验证；同一 ChatGPT 账号的数据由 Firebase UID 隔离并合并。不同 ChatGPT 账号仍分别储存。
7. 关闭开关即停止后续上传，并清除本地 Firebase 登录凭据和可选网络权限；不会删除本地或已有云端数据。

*说明：* 用户第一次需要接收邮件、复制链接，这是为了验证云端数据所有权。开启后不要求每次手动点击上传。Firebase Refresh Token 持久保存在当前 Chrome 配置文件中，直到退出、失效或用户清理数据。此方案**不依赖 Chrome 扩展 ID**或 Google OAuth 客户端；但真实 Firebase 邮件的发出和兑换仍需现场验收。

## 维护者配置

1. 在 Firebase 创建维护者拥有的项目（可先使用 Spark）、默认 Cloud Firestore，部署仓库根目录的 [firestore.rules](../firestore.rules)。
2. Authentication → Sign-in method：保持 **Email/Password** 启用，同时开启 **Email link (passwordless sign-in)**。之前开启的 Google 提供方不作为此功能所需前提，可按运营政策独立管理。
3. Authentication → Settings → Authorized domains：确认 Firebase Web App 的 `authDomain` 在授权域名列表中。用户收到的动作链接需来自该项目自己的 HTTPS Firebase Hosting 域名。
4. Project settings → General → Your apps → Web App → Config：分别找到 `projectId`、`apiKey`、`authDomain`。**authDomain 不一定等于 Project ID 加 firebaseapp.com**；2026 年以后新项目的默认 Hosting 站点 ID 可能不同。若尚无默认 Hosting 域名，应先按 Firebase 控制台提示创建站点，且无需部署用户网站代码。
5. GitHub 仓库 Settings → Secrets and variables → Actions → Variables 设定三项公开客户端配置：
   - `LUNATOC_FIREBASE_PROJECT_ID`：Firebase Web App 的 `projectId`。
   - `LUNATOC_FIREBASE_WEB_API_KEY`：Firebase Web App 的 `apiKey`。
   - `LUNATOC_FIREBASE_AUTH_DOMAIN`：Firebase Web App 的 `authDomain`，例如 `lunatoc-prod.firebaseapp.com`，**不带 https://、路径或引号**。
6. 对应 GitHub CI 的环境变量分别为 `VITE_LUNATOC_FIREBASE_PROJECT_ID`、`VITE_LUNATOC_FIREBASE_WEB_API_KEY` 和 `VITE_LUNATOC_FIREBASE_AUTH_DOMAIN`。旧的 `LUNATOC_GOOGLE_OAUTH_CLIENT_ID` 不再读取，可从仓库变量中删除。
7. 构建后检查“官方云同步配置已就绪”并执行真实邮件链接登录、Firestore 写入、另一 Chrome 配置文件读取、账号隔离和退出测试。**格式检查与模拟器测试并不等于真实部署成功。**

## 安全与限制

- 邮件 URL 是一次性登录凭据。扩展只接受所属 Firebase `authDomain` 的 HTTPS URL、`mode=signIn`、正确的 Web API Key，并将 `oobCode` 交给 Firebase 验证。绝不在日志中打印完整链接。
- 验证完成的 Firebase Refresh Token 持久保存在扩展本地存储，允许浏览器重启后自动同步；不要公开 Chrome 配置文件、扩展存储或任何凭据。
- 云端路径：`users/{firebaseUid}/accounts/acct_{sha256(chatgptOwnerId)}`；每份快照限制 240 KB。Firestore 规则禁止匿名读写、跨 UID、列举与删除，且要求合法数据结构。
- 同步使用三方合并、条件更新、删除保护和本地回滚。失败时保留本地数据；两台设备同时修改相同项目可能需要人工解决冲突。维护者可能查看云端明文内容；这不是端到端加密。
- Firebase 免费额度有上限，需监控同步请求频率、用量与恶意滥用。

## 自动测试

CI 包含类型检查、Vitest、Chromium 模拟页面测试、Firebase Emulator 加载真实 firestore.rules 的隔离测试、扩展打包和依赖安全审计。邮件发送及一次性代码兑换由模拟 REST 测试覆盖，但最终必须用维护者**真实 Firebase 项目和真实邮箱**完成联调。

本地 Firestore 模拟器测试（Node.js 22、Java 21）：

    npm --prefix test/firebase install --no-package-lock
    test/firebase/node_modules/.bin/firebase emulators:exec --only firestore --project demo-lunatoc-ci "node --test test/firebase/firestore.rules.test.mjs"
