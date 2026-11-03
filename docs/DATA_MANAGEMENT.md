# LunaTOC 数据管理规范

## 数据归属

- 每条提示词、目录别名和账号设置均归属一个经过验证的 ChatGPT `ownerId`。
- Firebase UID 是云端身份边界；同一 UID 下不同 ChatGPT 账号按 `accountHash = SHA-256(ownerId)` 独立存储。
- 未验证 Firebase 邮箱、未核验 ChatGPT 身份或未显式绑定的账号不得访问云端数据。
- 聊天正文、消息内容、访问令牌和密码不进入云端快照。

## 唯一云端结构

```text
users/{firebaseUid}/accounts/{accountHash}
  json: string

users/{firebaseUid}/usage/cloudWrites
  accountHashes: string[]
  lastAccountHash: string
  dailyWrites: integer
  windowStart: timestamp
  lastWriteAt: timestamp
```

账号快照的 `json` 是唯一云端快照载体，内容只包含业务数据：

```json
{
  "prompts": [],
  "aliases": {},
  "settings": null,
  "deletedRoutes": [],
  "deletedAliases": [],
  "deletedPrompts": []
}
```

云端快照和配额文档均不包含数据版本字段。客户端、Firestore Security Rules、模拟器、清库工具和维护文档统一使用上述路径与字段；不设置并行集合、双协议兼容或数据版本迁移逻辑。

## 同步规则

1. 首次同步以当前设备的本地数据为输入，远端文档不存在时创建快照。
2. 后续同步使用本地已确认基线、当前本地数据和远端快照进行三方合并。
3. 独立字段或记录的修改可以合并；同一记录同时发生不同修改时失败关闭，不覆盖任一方。
4. 账号切换、UID 改变、解绑、邮箱未验证或 ChatGPT 身份失效时立即停止同步。
5. 快照与配额通过单个原子提交写入；更新时间前提用于检测并发写入，冲突时重新读取并有限重试。
6. 无变化同步不消耗写入额度；服务端拒绝写入时不推进本地基线。

## 删除与保留

- 提示词、会话和目录别名删除分别写入所属账号的删除标记。
- 删除标记随快照同步，防止离线设备重新上线时恢复已删除数据。
- 不按 TTL、最近活跃时间或条目数量自动清除删除标记；达到容量上限时停止同步并保留数据。
- 远端同步删除与本地清理是不同操作。清理 Firestore 不删除 Firebase Authentication 用户，也不清除 Chrome 本地数据。

## 服务端约束

| 约束 | 值 | 执行位置 |
|---|---:|---|
| UID 写入冷却 | 5 秒 | Firestore Security Rules |
| 每 UID 固定 24 小时写入上限 | 100 次 | Firestore Security Rules |
| 每 UID ChatGPT 账号数 | 20 | Firestore Security Rules |
| 单账号快照大小 | 240,000 字节 | 客户端和 Firestore Security Rules |
| 每类删除标记 | 20,000 条 | 客户端快照校验 |

Firestore Rules 默认拒绝未明确声明的所有路径、列表查询和直接删除。账号快照写入必须与对应 UID 的配额更新处于同一原子提交。

## 初始化与日常维护

- 初始化时清理 Firestore 业务文档，不删除 Firebase Authentication 用户。
- 清库只涉及 `users/{uid}/accounts/{accountHash}` 与 `users/{uid}/usage/cloudWrites`。
- 清库后清除本地同步基线元数据一次；提示词、目录、设置、删除标记和本地备份保持不变。首次同步重新建立基线并上传本地权威数据。
- 每次生产操作前核对 Firebase Project ID 和默认 Firestore 数据库。清库工具默认只读盘点，只有显式执行并输入项目确认短语才删除；完成后必须再次盘点。
- 不把 Firebase Web API Key 当作管理凭据；生产清理使用受控的 Google Application Default Credentials，并只授予必要 Firestore 权限。

## 备份与恢复

- 本地导出备份是用户可恢复数据的主要备份形式。
- 导入前验证文件格式、账号归属和记录完整性；失败时回滚，不做部分覆盖。
- 云端快照不包含聊天正文；Firebase 云端不是端到端加密存储。
- 恢复时先确认 ChatGPT ownerId 与 Firebase UID 绑定，再执行合并或覆盖；任何覆盖操作必须由用户明确选择。
