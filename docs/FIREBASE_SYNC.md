# LunaTOC 邮箱＋密码云同步（维护者统一 Firebase）

## 使用流程
1. 安装扩展后所有数据仅保存在本地。保持 ChatGPT 已登录，打开扩展设置，打开可选的“自动云同步”。
2. 注册独立的 **LunaTOC 邮箱＋密码账号**，至少 12 位密码，由 Firebase Authentication 安全处理，扩展不保存明文密码。
3. 首次注册时 Firebase 发送**邮箱地址验证邮件**（不是只有 5 封/天的“邮件链接登录”邮件）。打开邮件点击确认链接，再回到扩展点击“我已完成邮箱验证”。
4. 仅验证成功后，在设置页**明确选择将当前 ChatGPT 账号绑定至正在登录的 LunaTOC 云账号**，再首次同步。其他 ChatGPT 账号保持仅本地存储，不会自动上传。
5. 在另一台设备使用**相同 LunaTOC 邮箱、密码和相同 ChatGPT 账号**登录，在该设备再次确认绑定后下载云数据。
6. 同一 Firebase UID 可分别绑定多个 ChatGPT 账号并独立存储；切换 Firebase UID 不自动迁移本地 ChatGPT 账号。解绑仅删除本机绑定关系，不删除数据。
7. 关闭同步即撤销本机 Firebase 登录会话、停止后续上传，不删除本地数据或已上传的云端副本。浏览器完全退出后登录凭据也会清除：下次打开 Chrome 需要重新登录 LunaTOC 云账号并重新开启自动同步；浏览器后台服务暂时休眠不等于退出浏览器，不会因此退出登录。

## 维护者 Firebase 配置
1. 可使用 Spark 免费方案。Project settings → General → Your apps → 注册 Firebase Web App，获取真实 `projectId`、`apiKey`、`authDomain`。自 2026-10-15 起新建项目不再自动创建默认 Hosting 站点；若 Web App Config 缺少 `authDomain`，按 Firebase 控制台提示先创建默认 Hosting 站点，再从 Config 读取实际域名，不能按 Project ID 猜测。
2. Authentication → Sign-in method → 启用 **Email/Password**，关闭 **Email link (passwordless)**。Authentication → Settings → Password policy 建议强制至少 12 位；保留默认邮箱枚举防护。
3. Authentication → Settings → Authorized domains：检查真实 `authDomain`，验证邮件中的 Firebase Action URL 应能打开。新建项目的默认 Hosting Site ID 不一定与 Project ID 完全相同。
4. Build → Firestore Database → 创建默认数据库，选择正确区域。生产环境必须部署仓库的 **`firestore.rules`**。
5. 仓库根目录已有 `firebase.json`，使用 `firebase deploy --only firestore:rules --project <PROJECT_ID>` 部署，不要用开放规则或另一个项目的规则。当前规则要求 Firebase UID 正确、邮箱已验证、账户哈希合法，且禁止列举、删除和其他集合访问。
6. GitHub Settings → Secrets and variables → Actions → Variables 中配置三个**公开客户端字段**：
   - `LUNATOC_FIREBASE_PROJECT_ID` = Firebase Web App `projectId`
   - `LUNATOC_FIREBASE_WEB_API_KEY` = Firebase Web App `apiKey`
   - `LUNATOC_FIREBASE_AUTH_DOMAIN` = Firebase Web App `authDomain`（不带协议和路径）
7. CI 打包时自动嵌入对应 `VITE_LUNATOC_FIREBASE_*` 配置。生产 Firebase 项目不可由扩展用户自行改写。严禁把服务账号私钥放到客户端或普通仓库变量里。
8. 完成真实双用户、未验证邮箱、断网、双设备、同步冲突测试后，才可合并发布 PR。

## 安全、配额和数据隔离
- Firebase Authentication 保管密码。扩展仅在 Chrome 的临时会话存储中保存 Firebase ID/Refresh Token，不写入长期本地存储；关闭同步或完全退出浏览器后清理登录会话。本次更新也会删除此前保存在长期本地存储中的登录凭据，要求重新登录。
- **没有自定义用户名登录**；“LunaTOC 账号”是与 ChatGPT 账号独立的邮箱密码账号。若要自定义用户名，需要独立认证后端。
- 数据路径为 `users/{firebaseUid}/accounts/acct_{sha256(chatgptOwnerId)}`，每份快照最多约 240 KB。同步 Tips、目录别名与偏好，不上传聊天正文；云端不是端到端加密，项目维护者有能力查看存储明文。
- 未验证邮箱的账号无权访问 Firestore，包含 `get` 和 `create/update`；不同 Firebase UID 之间也互相拒绝。
- 仅同步当前 Firebase UID 明确绑定的 ChatGPT 账号。断网临时失败时通过 Chrome MV3 alarms 与有界指数退避重试，并每小时检查云端；并发修改采取三方合并和写入前提保护。主题和侧边栏按独立字段合并，其他同字段冲突必须提示而非静默覆盖。
- Firebase Spark 额度（以官网为准）：邮件链接登录 **5 封/项目/天**，本方案不使用；首次邮箱验证 **1,000 封/项目/天**，密码重置 **150 封/项目/天**；正常密码登录不消耗邮件发送额度。依然受注册、认证速率和 Firestore 免费读写额度约束。
- 不要未经维护者确认升级 Blaze，也不要关闭邮箱验证或弱化安全规则来规避限额。

## 登录失败：Failed to fetch / 无法连接 Firebase
- 这属于浏览器网络请求失败，不是密码错误，也不能据此判断 Firebase Authentication 配置正确。扩展现在提示具体 Firebase 域名及权限状态。
- 在 Chrome 的 `chrome://extensions` → LunaTOC → 详细信息 → 网站访问权限，检查已允许访问 `identitytoolkit.googleapis.com`、`securetoken.googleapis.com`、`firestore.googleapis.com`。也可以在设置里关闭再开启自动云同步，以重新触发网站访问授权。
- 如已授权但仍报网络失败，在相同 Chrome 配置文件中确认网络、DNS、代理、系统防火墙、广告拦截/隐私扩展或企业策略是否阻断上述 Google API 域名。网络环境无法访问这些域名时，扩展无法直接登录 Firebase。
- 打开 `chrome://extensions` → LunaTOC → Service worker → 检查（Inspect），在 DevTools Network 中确认失败请求的域名和网络错误码；不要向他人分享请求体、密码、ID token 或 refresh token。
- 需要区分：HTTP `INVALID_LOGIN_CREDENTIALS` 是 Firebase 返回的账号凭据错误；`Failed to fetch` 是浏览器没有收到可用的 HTTP 响应；`PERMISSION_DENIED` 来自 Firestore 规则。不要为了修复连接问题把 Firestore 规则改为公开。
- 未登录成功前不启用云同步，不会自动绑定其他本地 ChatGPT 账号。

## 主题行为
- LunaTOC 不再读取或监测 ChatGPT 页面深浅色；新安装和旧版“跟随 ChatGPT”设置均采用浅色作为默认。
- 弹窗内可以手动切换浅色/深色，并按 ChatGPT 账号保存。旧版已明确选择的手动深色偏好继续保留，备份及云端快照支持兼容读取。

## 自动化与真实验收
CI 使用仓库的真实 `firestore.rules` 运行 Firestore Emulator，测试邮箱已验证的 A/B UID、未验证邮箱、匿名访问、异常文档和越权。Vitest 覆盖密码登录、注册验证、凭据错误、账号同步、网络故障；Chromium E2E 使用模拟 ChatGPT，不等于真实 ChatGPT/生产 Firebase 验收。

本地模拟器命令：
```sh
npm --prefix test/firebase install --no-package-lock
test/firebase/node_modules/.bin/firebase emulators:exec --only firestore --project demo-lunatoc-ci "node --test test/firebase/firestore.rules.test.mjs"
```

正式上线前还必须在真实项目测试：真实邮箱收到地址验证并点击、禁用验证前云访问、两台 Chrome 配置文件使用相同 Firebase UID 和 ChatGPT 身份同步、不同 UID 互拒、账号切换、断网重试与冲突提示。记录实际 CI 与 Chrome 截图，验证并非只看 Firebase 控制台内的数据。
