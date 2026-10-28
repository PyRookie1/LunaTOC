# Firebase Spark 云同步配置（LunaTOC 1.0.0）

LunaTOC 的 Firebase 同步默认关闭；配置自己的 Firebase 项目并在设置页点击“立即同步”后才会发生云端传输。用户可以保持完全本地使用。

## 配置步骤

1. 在 [Firebase 控制台](https://console.firebase.google.com/) 创建项目，选择 Spark 免费方案，创建 Cloud Firestore（Native 模式、默认数据库）。
2. 在 Authentication → Sign-in method 开启 Email/Password。不需要 Google OAuth、服务账号 JSON 或管理后台私钥。
3. 在 Firestore → Rules 中部署仓库根目录的 [firestore.rules](../firestore.rules)。拒绝访问所有其他路径，不允许客户端列出或删除账号文档。
4. 从 Firebase 项目 Web App 设置取得 Project ID 和 Web API Key，打开 LunaTOC 扩展“设置 → Firebase 云同步”，输入并保存；按浏览器提示授权访问 3 个 Firebase API 主机。
5. 在同一个设置页通过 Firebase Email/Password 登录或注册。必须在 ChatGPT 标签页登录想同步的账号，并确保扩展已识别。先导出本地备份，再选择账号并点击“立即同步”。
6. 在第二台设备使用同一个 Firebase 项目和 Firebase 登录账号，以相同方式点击同步。不同 ChatGPT 账号的数据不会合并到一起。

项目 Web API Key 不是私钥；真正授权依赖 Firebase Authentication ID Token + Firestore Security Rules。不要将 Firebase 管理员密钥、服务账号私钥或 ChatGPT 登录令牌放入扩展。

## 同步范围与行为

| 数据类别 | 行为 |
|---|---|
| Tips 提示词标题、正文与时间戳 | 按 ChatGPT 账号同步 |
| 自定义目录名称 | 按会话、账号同步 |
| 已确认会话的删除围栏 | 与对应账号的历史快照合并；传播已知删除记录 |
| 账号主题、侧边栏偏好 | 按 ChatGPT 账号同步 |
| ChatGPT 对话正文、账号邮箱、浏览器 Cookie | 不上传 |
| 提示词使用统计、其他扩展设置 | 仅本地 |

Firestore 数据路径为 users/{firebaseUid}/accounts/{sha256(chatgptOwnerId)}，每个账号一个文档。服务器用 UID 规则保证 Firebase 用户隔离；客户端再次检查 ChatGPT 会话归属。邮箱仅用于 Firebase 登录和本地显示，不作为归属 ID。

每次点击同步通常读取一个账号文档，只有内容改变时才写入一次；不会订阅实时侦听器或后台不断扫描。单文档快照最多 240 KB，以避免超过 Firestore 文档上限并约束免费配额消耗。超过上限时会报错，不会截断私有数据。

## 本地优先、删除和冲突处理

- 断网或云端失败时，本地目录、提示词及偏好照常工作；云端同步返回错误，不清空本地内容。
- 每台设备保留上次成功同步的账号基线。同步时对基线、本地、云端进行逐提示词、逐会话、整组账号偏好的三方比较。
- 一方修改、另一方未改时可合并；两边修改同一条且不一致时停止并提示冲突，不采用简单的最后写入覆盖。
- 与基线对照后识别的删除会同步传播。确认删除的会话保护标记不会转换为普通别名；没有基线时不能推断旧记录的归属。
- Firestore PATCH 带 currentDocument.updateTime 或 exists=false 前置条件，阻止其他设备在读取后写入造成的静默覆盖。
- 合并写入本地仅限对应账号，并在失败时尝试回滚；其他本地数据不包含在云端写入中。

**已知限制：** 目前通过设置页手动同步；浏览器重启后需重新登录 Firebase。云端不可用时没有后台重试队列，请恢复网络后再点击同步。首次多设备同步时，如两个设备都已有不同偏好或相同 ID 的不同提示词，可能需要先导出本地备份并手动解决冲突。模拟测试不等于真实 Firebase 项目、真实 ChatGPT 账号的联调验收。

## Spark 用量

以 Firebase 官方 [Firestore 用量说明](https://firebase.google.com/docs/firestore/pricing)为准。标准模式下免费额度包括 1 GiB 数据、每日 50,000 次文档读取及 20,000 次文档写入；额度可能变动或受其他 Firebase 产品限制。LunaTOC 使用按需单文档读写，没有付费功能（如 PITR、TTL 删除或云端备份）。请在 Firebase 控制台监控用量。
