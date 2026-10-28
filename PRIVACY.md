# LunaTOC 隐私说明

本说明适用于 [PyRookie1/LunaTOC](https://github.com/PyRookie1/LunaTOC) 仓库中的 Chrome 扩展。

## 处理的信息

- 为生成对话目录和回答标题索引，扩展会读取 ChatGPT 页面中已显示的消息，并处理 ChatGPT 页面请求返回的会话消息数据。相关处理主要在浏览器内完成。
- 为识别当前 ChatGPT 账号，扩展隔离环境会请求 ChatGPT 自身的同源接口 `/api/auth/session`，读取账号 ID 和可用的邮箱字段。页面通过 `postMessage` 传来的账号身份不会被当作可信身份。
- Tips 提示词、自定义目录名称、使用统计、主题与侧边栏偏好保存在 Chrome 本地存储中。部分界面状态可能保存在当前标签页的 Web Storage 中。
- 本地备份可包含已保存的提示词、目录别名、使用统计和账号偏好；不会导出 ChatGPT 对话正文、浏览器会话凭证或任意未知存储键。备份文件可能包含私人内容和账号标识，应妥善保管。
- 用户手动导入文件时，扩展会在浏览器内解析文件内容。

## 用户主动配置的 Firebase 云同步

云同步默认关闭。用户可在设置页提供自己的 Firebase Project ID 与 Web API Key，经浏览器额外授权后使用 Firebase Email/Password 认证，并明确选择要同步的 ChatGPT 账号。仅会上传该账号的 Tips 提示词及正文、目录别名、主题和侧边栏偏好、会话删除标记；不会上传完整 ChatGPT 对话正文、使用统计、账号邮箱或 ChatGPT Cookie。

Firebase 登录密码仅用于发送给 Google Identity Toolkit，不由扩展持久保存。Firebase ID Token / Refresh Token 存储在 Chrome 的会话级存储中，浏览器重启后需要重新登录。Firebase 项目配置（公开 Web API Key）和成功同步的基线保存在本地。Firebase 账号 UID 决定云端权限边界，ChatGPT 账号 ID 的 SHA-256 摘要用于其下的数据分组；Firebase 项目控制者可能访问明文云端数据，请勿将其视为端到端加密。

同步通过 identitytoolkit.googleapis.com、securetoken.googleapis.com 和 firestore.googleapis.com 传输。使用 Firebase 需要用户自行部署安全规则，可能受到 Google Firebase 服务条款、隐私政策和用量限制。设置说明见 [Firebase 云同步](docs/FIREBASE_SYNC.md)。

## 网络与数据传输

扩展需要访问 ChatGPT 自身的页面和同源接口，以显示目录并识别登录账号。默认不会上传用户存储数据。用户主动请求云同步时，所选账号的数据通过 HTTPS 上传到用户自行配置的 Google Firebase 项目；不会上传到 LunaTOC 维护者服务器。项目不包含使用行为遥测或广告追踪。

## 权限

`manifest.json` 使用 Chrome 的 `storage` 和 `webRequest` 权限，并将默认主机权限限定为 `chatgpt.com` 与 `chat.openai.com`。Firebase API 主机权限为可选权限，仅在用户主动配置云同步时申请。网络观察逻辑只用于识别这两个站点中与会话删除相关的请求是否成功，不阻止或修改请求，也不会把请求内容发送到外部服务。

扩展不会在 Microsoft Copilot 或其他聊天站点注入脚本。

## 数据控制

用户可以通过扩展设置页导出或清理本地扩展数据，也可以在 Chrome 中移除扩展。卸载扩展不会自动删除用户主动导出的备份文件。

