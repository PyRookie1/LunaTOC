# LunaTOC 隐私说明

本说明适用于 [PyRookie1/LunaTOC](https://github.com/PyRookie1/LunaTOC) 的 Chrome 扩展。

## 本地处理

- 扩展读取 ChatGPT 页面已显示的消息、相关会话数据，并通过同源 `/api/auth/session` 识别已登录的 ChatGPT 账号。
- Tips、目录别名、使用统计、主题和布局等偏好默认保存在本地；手动导出的 JSON 备份可能包含私人内容和账号标识。
- 默认不向 LunaTOC 维护者上传这些数据；不包含行为遥测或广告追踪。

## 可选 Firebase 自动云同步

云同步默认关闭，由维护者统一管理 Firebase 项目。用户开启开关时，扩展请求访问 Firebase 网络服务，用户需输入邮箱收取一次性验证链接，并将邮件中的**完整链接复制粘贴到扩展设置页**。验证成功后 Firebase 自动建立或识别相同邮箱的同步身份；无需用户设置密码或单独注册 LunaTOC 账号。邮件链接是一次性登录凭证，切勿转发或公开。

- 开启后，扩展在本地提示词、目录别名、账号偏好变化或已验证 ChatGPT 标签页出现时自动尝试同步。断网、权限拒绝、冲突或令牌失效时应保留本地数据并报告错误。
- 上传范围：所选 ChatGPT 账号的 Tips 标题与正文、目录别名、主题与布局偏好、已知会话删除标记；**不上传**完整聊天正文、使用统计、ChatGPT 登录令牌及 ChatGPT 登录邮箱。
- Firebase Authentication 接收用户验证邮箱与一次性验证码。邮箱在发送链接后暂存于扩展本地存储，以便完成登录；成功验证后清除待验证邮箱。
- Firebase ID Token / Refresh Token 存储在扩展本地存储，以允许浏览器重启后继续自动同步。**这是持久登录凭据**：具有该 Chrome 配置文件访问权限的人员或恶意软件可能获取它们。关闭同步会清除本地凭据，但不会自动删除已上传云端数据。
- 云端路径以 Firebase UID 和 ChatGPT 账号 ID 的 SHA-256 摘要分组。LunaTOC 维护者可能直接查看已同步的 Tips 与目录名称**明文内容**；同步不是端到端加密。
- 跨设备需使用同一验证邮箱、同一 ChatGPT 账号，并分别开启云同步。允许用户随时关闭云同步，继续完全本地使用扩展。

Firebase 服务使用 identitytoolkit.googleapis.com、securetoken.googleapis.com、firestore.googleapis.com；详见 [云同步操作说明](docs/FIREBASE_SYNC.md)。

## 网络与权限

`manifest.json` 使用 `storage`、`webRequest`，默认主机权限仅限 `chatgpt.com` 和 `chat.openai.com`。Firebase API 主机权限为可选权限，仅当用户主动开启云同步时请求。扩展不会向其他聊天站点注入脚本，不会阻断或修改监听到的 ChatGPT 删除请求。

## 数据控制

用户可以导出或清理本地数据，并关闭云同步；关闭或卸载扩展不会自动删除云端文档或用户已导出的备份文件。联系维护者处理云端副本的管理问题前，不要把邮件验证链接或刷新令牌发送给任何人。
