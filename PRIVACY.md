# LunaTOC 隐私说明

本说明适用于 [PyRookie1/LunaTOC](https://github.com/PyRookie1/LunaTOC) 的 Chrome 扩展。

## 本地处理

- 扩展读取 ChatGPT 页面已显示的消息、相关会话数据，并通过同源 `/api/auth/session` 识别已登录的 ChatGPT 账号。
- Tips、目录别名、使用统计、主题和布局等偏好默认保存在本地；手动导出的 JSON 备份可能包含私人内容和账号标识。
- 默认不向 LunaTOC 维护者上传这些数据；不包含行为遥测或广告追踪。

## 可选 Firebase 自动云同步

云同步默认关闭，由维护者统一管理 Firebase 项目。用户开启开关时，扩展请求访问 Firebase 网络服务，用户首次注册 LunaTOC 云账号时需输入邮箱和密码，Firebase 发送邮箱地址验证邮件；验证后可使用相同邮箱与密码在其他设备登录。Firebase 处理密码，扩展不保留明文密码。邮箱验证链接是一次性凭证，切勿转发或公开。

- 用户必须先将当前 ChatGPT 账号明确绑定到当前已验证的 LunaTOC 云账号，只有与已登录 Firebase UID 匹配的绑定账号才能上传或下载。未绑定的本地 ChatGPT 账号不会自动上传；切换 LunaTOC 云账号时不会自动转移其他账号的数据。解除绑定不会删除本地或云端副本。
- 开启后，扩展在已绑定账号的本地提示词、目录别名、账号偏好变化或已验证 ChatGPT 标签页出现时自动尝试同步，并在启用期间通过 Chrome alarms 每 60 分钟检查云端变化。临时网络失败记录待同步状态、使用有上限的指数退避重试；权限拒绝、冲突或令牌失效时保留本地数据并报告错误，等待用户处理。
- 上传范围：所选 ChatGPT 账号的 Tips 标题与正文、目录别名、主题与布局偏好、已知会话删除标记；**不上传**完整聊天正文、使用统计、ChatGPT 登录令牌及 ChatGPT 登录邮箱。
- Firebase Authentication 接收注册邮箱和密码并发送首次邮箱验证邮件。扩展调用 Firebase 的注册、密码登录、验证状态查询及密码重置接口；密码仅用于当次认证请求，不持久保存明文。
- Firebase UID 与登录邮箱用于在本机显示 LunaTOC 云账号及 ChatGPT 绑定归属；登录邮箱和 Firebase ID Token / Refresh Token 保存在扩展本地存储，不会作为同步内容上传至 Firestore。**这是持久登录凭据**：具有该 Chrome 配置文件访问权限的人员或恶意软件可能获取它们。关闭同步会清除本地凭据，但不会自动删除已上传云端数据。
- 账号与 Firebase UID 的绑定关系只保存在本机，不包含在自动云端快照或 JSON 本地备份中。云端路径以 Firebase UID 和 ChatGPT 账号 ID 的 SHA-256 摘要分组。LunaTOC 维护者可能直接查看已同步的 Tips 与目录名称**明文内容**；同步不是端到端加密。
- 跨设备需使用同一验证邮箱、同一 ChatGPT 账号，并分别开启云同步。允许用户随时关闭云同步，继续完全本地使用扩展。

Firebase 服务使用 identitytoolkit.googleapis.com、securetoken.googleapis.com、firestore.googleapis.com；详见 [云同步操作说明](docs/FIREBASE_SYNC.md)。

## 网络与权限

`manifest.json` 使用 `storage`、`webRequest`、`alarms`（后者用于已开启云同步的重试和定期检查），默认主机权限仅限 `chatgpt.com` 和 `chat.openai.com`。Firebase API 主机权限为可选权限，仅当用户主动开启云同步时请求。扩展不会向其他聊天站点注入脚本，不会阻断或修改监听到的 ChatGPT 删除请求。

## 数据控制

用户可以导出或清理本地数据，并关闭云同步；关闭或卸载扩展不会自动删除云端文档或用户已导出的备份文件。联系维护者处理云端副本的管理问题前，不要把登录密码、邮箱验证链接或刷新令牌发送给任何人。
