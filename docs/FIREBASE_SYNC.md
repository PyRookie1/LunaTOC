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
5. 仓库根目录已有 `firebase.json`，使用 `firebase deploy --only firestore:rules --project <PROJECT_ID>` 部署，不要用开放规则或另一个项目的规则。当前规则要求 Firebase UID 正确、邮箱已验证、账户哈希合法、每次快照写入同时原子更新 UID 配额文档，并禁止绕过配额的单文档写入、列举、删除和其他集合访问。
6. GitHub Settings → Secrets and variables → Actions → Variables 中配置三个**公开客户端字段**：
   - `LUNATOC_FIREBASE_PROJECT_ID` = Firebase Web App `projectId`
   - `LUNATOC_FIREBASE_WEB_API_KEY` = Firebase Web App `apiKey`
   - `LUNATOC_FIREBASE_AUTH_DOMAIN` = Firebase Web App `authDomain`（不带协议和路径）
7. CI 打包时自动嵌入对应 `VITE_LUNATOC_FIREBASE_*` 配置。生产 Firebase 项目不可由扩展用户自行改写。严禁把服务账号私钥放到客户端或普通仓库变量里。
8. 完成真实双用户、未验证邮箱、断网、双设备、同步冲突测试后，才可合并发布 PR。

## 安全、配额和数据隔离
- Firebase Authentication 保管密码。扩展仅在 Chrome 的临时会话存储中保存 Firebase ID/Refresh Token，不写入长期本地存储；关闭同步或完全退出浏览器后清理登录会话。本次更新也会删除此前保存在长期本地存储中的登录凭据，要求重新登录。
- **没有自定义用户名登录**；“LunaTOC 账号”是与 ChatGPT 账号独立的邮箱密码账号。若要自定义用户名，需要独立认证后端。
- 统一数据路径为 users/{firebaseUid}/accounts/acct_{sha256(chatgptOwnerId)}，配额文档为 users/{firebaseUid}/usage/cloudWrites；Firestore 账号文档只保存 json 字段，快照仅包含提示词、目录别名、设置和删除标记，不包含数据版本字段；每份快照最多约 240 KB。同步 Tips、目录别名与偏好，不上传聊天正文；云端不是端到端加密，项目维护者有能力查看存储明文。提示词删除、最后一个目录标签删除和整段会话删除分别保留账号归属明确的删除标记；删除标记与快照按 ChatGPT 账号隔离，不能由另一账号清除。旧版快照缺少删除字段时，升级逻辑会根据本机已确认基线补齐标记。
- 未验证邮箱的账号无权访问 Firestore，包含 `get` 和 `create/update`；不同 Firebase UID 之间也互相拒绝。
- 仅同步当前 Firebase UID 明确绑定的 ChatGPT 账号。没有可验证的已绑定 ChatGPT 页面，或者本地有待上传修改时，设置页显示「自动同步待完成」，不会沿用上次的成功提示；只有本轮对至少一个已验证账号完成同步才显示成功。断网临时失败时通过 Chrome MV3 alarms 与有界指数退避重试，并每小时检查云端；并发修改采取三方合并和写入前提保护，Firestore 写入前提冲突会重新读取并最多重试三轮。提示词、目录记录和会话删除采用不同级别的持久删除标记；删除与同一条目的并发编辑会停止合并并保留本地数据，首次同步时遇到云端删除标记也不会静默复活旧副本。主题和侧边栏按独立字段合并，其他同字段冲突必须提示而非静默覆盖。远端会话删除事件在请求发起时捕获已验证的 ChatGPT 账号，并由后台先持久化账号归属删除标记，再通知原标签页；账号切换不会把删除归到新账号。
- Firebase Spark 额度（以官网为准）：邮件链接登录 **5 封/项目/天**，本方案不使用；首次邮箱验证 **1,000 封/项目/天**，密码重置 **150 封/项目/天**；正常密码登录不消耗邮件发送额度。依然受注册、认证速率和 Firestore 免费读写额度约束。
- 不要未经维护者确认升级 Blaze，也不要关闭邮箱验证或弱化安全规则来规避限额。

## 删除标记保留与容量边界

删除标记是防止旧设备恢复已删除数据的同步安全状态，不是可以按时间清理的缓存。当前同步协议仅在每台设备本地保存该设备已确认的同步基线，没有云端设备注册表，也没有每台设备对删除代次的确认记录。因此，服务端无法证明某条删除标记已被所有仍可能上线的设备接收。

- 不设置删除标记 TTL，不按年龄、数量或最近活跃时间自动压缩/删除删除标记。
- 每份云端快照的 `deletedRoutes`、`deletedAliases`、`deletedPrompts` 各自最多 20,000 条；完整快照最多 240 KB。
- 本地每个 ChatGPT 账号的提示词删除标记最多 20,000 条。
- 达到数量或字节上限时，相关写入/同步必须失败并保留现有数据；不得为了腾出空间而静默移除旧标记。
- 用户不得通过清空本地数据、重置云端或删除标记来绕过限制。遇到上限应先备份并停止覆盖操作。

未来只有在实现云端设备注册、单调递增的同步代次、每设备确认水位，以及明确的设备撤销/过期策略后，才能安全回收所有仍可能访问的设备均已确认的删除标记。该协议不属于当前同步机制。

## 服务端写入配额与防滥用

所有云端快照写入必须通过 Firestore `documents:commit`，在同一个原子提交中同时更新账号快照和 `users/{uid}/usage/cloudWrites` 配额文档。Security Rules 使用 `getAfter()` 检查两份文档确实一起改变，并使用服务端 `request.time` / `REQUEST_TIME` 验证时间与计数；直接对账号文档执行旧式 PATCH、单独修改配额文档或删除配额文档均会被拒绝。客户端计数只用于显示错误，不能授权写入。

每个 Firebase UID 的服务端限制：

| 限制 | 上限 | 计算方式 |
|---|---:|---|
| 写入频率 | 每 5 秒最多 1 次 | 跨该 UID 下全部 ChatGPT 账号共享 |
| 写入次数 | 每个固定 24 小时窗口最多 100 次 | 只统计实际改变云端快照的原子提交；无变化同步不扣额度 |
| 已注册云端 ChatGPT 账号数 | 最多 20 个 | 以配额文档中的账号哈希注册表计数 |
| 单个账号快照大小 | 240,000 字节 | Firestore Security Rules 服务端检查 |

固定 24 小时窗口从该 UID 第一次成功写入时开始；只能在服务器确认窗口已过期后重置。每次成功写入同时写入快照和配额文档，二者要么全部成功，要么全部失败。并发设备共享同一配额文档更新时间前提，过期提交会重新读取后重试；服务端频率/每日额度拒绝时，本地数据和同步基线均不前移。

配额按 Firebase UID 计算，不跨多个 Firebase UID 合并。账号注册表最多 20 个；升级前已存在的账号文档在下一次成功写入时惰性加入注册表，尚未注册的账号文档仍可读取，但必须先获得注册名额才能继续写入。达到上限不会删除任何云端数据。

本方案不引入 Cloud Functions、服务账号密钥或 Blaze 付费依赖。Firestore Security Rules 是最终强制边界；不能将客户端本地计数器或 UI 限制视为安全控制。每次写入额外更新一份配额文档并读取其状态，会增加 Firestore 读写用量，维护者应结合实际活跃 UID 数量监控 Spark 免费额度。

**发布兼容性：** 新版客户端与新版 `firestore.rules` 必须作为同一版本发布。新规则启用后，旧版客户端的单文档 PATCH 会被拒绝；新版客户端在旧规则下也无法提交配额文档。当前 1.0.0 尚未正式发布，发布前必须先将新版客户端与规则一起验收，不得提前只部署其中一方。

## 云端数据初始化与管理

统一数据结构、数据归属、同步规则、删除标记和日常维护方式见 [DATA_MANAGEMENT.md](./DATA_MANAGEMENT.md)。当前数据集按单一正式结构运行，不保留并行集合或跨版本迁移逻辑。

- 账号快照统一存储在 `users/{uid}/accounts/{accountHash}`，文档只包含 `json`；写入配额统一存储在 `users/{uid}/usage/cloudWrites`。
- 快照 JSON 和配额文档均不包含数据版本字段；字段集合由客户端和 Firestore Rules 共同校验。
- 本次初始化会清空 LunaTOC 自有的 Firestore 业务文档，再由客户端从本地权威数据重新建立快照；Firebase Authentication 用户、Chrome 本地提示词、目录、设置和删除标记均保留。
- 仓库提供 `scripts/firebase-firestore-reset.mjs`。默认只读盘点；执行时只删除 `users/{uid}/accounts/{hash}` 和 `users/{uid}/usage/cloudWrites`，要求项目 ID 二次确认和人工确认短语，并在删除后重新盘点。它不会删除 Authentication 用户或本地浏览器数据。
- 初始化后客户端只使用统一的 `lunatoc:cloud:baseline:` 同步基线。首次同步从本地数据建立远端快照；之后通过原子提交、更新时间前提和三方合并维持多设备一致性。
- CI 只对 Firestore Emulator 执行测试，不连接或清空生产 Firebase。

## 请求超时与重试
- Firebase 单次请求（包括接收完整响应内容）最长等待 20 秒；超时会取消网络请求，并返回明确错误，不会无限卡住扩展后台任务。
- 开启自动同步时，超时属于可以重试的网络故障：本轮显示失败，Chrome 会按现有逐步延长的间隔重新尝试；提示词、别名和偏好不会仅因超时被删除。
- 重新尝试时应确保 Chrome 可以访问 Firebase API；如果账号已退出登录，需要重新登录并开启自动同步。连续出现超时时检查网络、代理及拦截扩展。

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
CI 同时运行 Firebase Authentication 与 Firestore Emulator：使用真实 Auth Emulator token 验证注册、未验证拒绝、邮箱验证 OOB code、原子快照/配额写入、错误密码、密码重置及双 UID 隔离；Firestore Rules Unit Testing 继续覆盖匿名访问、配额边界、直接写入绕过、异常文档和删除限制。Vitest 另覆盖账号同步、网络故障；Chromium E2E 使用模拟 ChatGPT，不等于真实 ChatGPT/生产 Firebase 验收。

本地模拟器命令：
```sh
npm --prefix test/firebase install --no-package-lock
test/firebase/node_modules/.bin/firebase emulators:exec --only auth,firestore --project demo-lunatoc-ci "node --test --test-concurrency=1 test/firebase/auth-emulator.test.mjs test/firebase/firestore.rules.test.mjs test/firebase/firestore-reset-emulator.test.mjs"
```

正式上线前还必须在真实项目测试：真实邮箱收到地址验证并点击、禁用验证前云访问、两台 Chrome 配置文件使用相同 Firebase UID 和 ChatGPT 身份同步、不同 UID 互拒、账号切换、断网重试与冲突提示。记录实际 CI 与 Chrome 截图，验证并非只看 Firebase 控制台内的数据。
