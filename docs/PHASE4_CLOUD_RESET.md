# 第四阶段：Firestore 初始化与统一数据管理

## 目标

当前没有需要迁移的历史业务数据，因此不建立并行集合、不保留双版本兼容逻辑，也不在云端集合路径或业务文档字段中使用数据版本标记。本阶段直接将 Firestore 清理到空业务状态，再以唯一数据结构开始运行。

## 清理范围

只清除 LunaTOC 在默认 Firestore 数据库中的业务文档：

- `users/{uid}/accounts/{accountHash}`：ChatGPT 账号快照。
- `users/{uid}/usage/cloudWrites`：该 Firebase UID 的写入配额记录。

不删除 Firebase Authentication 用户，不清除 Chrome 本地存储，不删除提示词、目录、主题设置、删除标记或本地备份。Firestore Security Rules 只开放上述业务路径，其余路径默认拒绝。

## 统一数据结构

- 快照路径：`users/{uid}/accounts/{accountHash}`。
- 快照文档：仅包含 `json` 字符串字段；JSON 只包含提示词、目录别名、设置和删除标记等业务字段，不包含数据版本字段。
- 配额路径：`users/{uid}/usage/cloudWrites`。
- 配额字段：`accountHashes`、`lastAccountHash`、`dailyWrites`、`windowStart`、`lastWriteAt`。
- 本地同步基线：`lunatoc:cloud:baseline:{projectId}:{uid}:{accountHash}`。
- 快照与配额必须通过同一 Firestore 原子提交更新；服务端规则继续强制 UID 归属、邮箱验证、5 秒冷却、固定 24 小时 100 次上限、20 个 ChatGPT 账号上限及 240 KB 快照上限。

## 清库工具

脚本：`scripts/firebase-firestore-reset.mjs`。

- 默认只读盘点，输出业务文档数量和摘要，不删除数据。
- 显式传入 `--execute` 才进入删除流程。
- 只选择上述两个精确业务路径，不操作其他 Firestore 路径。
- 必须指定 `--project-id`，并用 `--confirm-project-id` 再次精确确认项目。
- 使用 Google Application Default Credentials；每批删除使用文档 `updateTime` 前提，避免误删盘点后发生变化的文档。
- 删除后重新盘点，只有两类规范业务文档均为零才报告成功；若 batchWrite 部分失败、updateTime 冲突或盘点期间出现新文档，停止后续批次并再次盘点，输出已确认删除数与剩余数，不把部分成功报告为完整成功。
- 盘点还会统计 accounts/usage 集合组中不符合规范路径的候选文档；这些文档不会被删除，必须单独审计，避免扩大清理范围。
- 可用 `--report-file <新文件路径>` 保存盘点/执行报告。目标文件必须不存在；脚本会在任何破坏性请求前独占创建报告文件，权限为仅当前用户可读写。
- 每条删除写入携带盘点时的 `updateTime` 前提；盘点后被其他客户端修改的文档不会被误删。
- Firebase Authentication 用户与本地浏览器数据不受影响；脚本只访问 Firestore REST API，不调用 Authentication API，也不连接 Chrome 存储。

执行命令：

```sh
gcloud auth application-default login
node scripts/firebase-firestore-reset.mjs --project-id <FIREBASE_PROJECT_ID>
node scripts/firebase-firestore-reset.mjs --project-id <FIREBASE_PROJECT_ID> --execute --confirm-project-id <FIREBASE_PROJECT_ID>
```

执行前检查只读盘点结果和项目 ID，先导出本地备份，并在维护窗口暂停所有客户端自动同步，避免清理期间持续产生新文档。若盘点本来就是零，清库操作为 no-op。

当前扩展在每个浏览器配置文件首次初始化时，仅清除一次旧的 `lunatoc:cloud:baseline:` 同步确认元数据，并写入 `lunatoc:cloud:baseline-reset` 标记；提示词、目录、设置和删除标记不变。该一次性动作用于首次统一数据结构的发布，不会在标记已存在时因维护者再次运行清库脚本而自动重做。生产清库必须安排在首次正式同步前，并确保所有待验收客户端都运行含该初始化逻辑的版本。正式使用后若要再次清空云端，必须另行设计逐设备明确确认的基线重建流程；不得直接重跑清库脚本并假设所有客户端会自动恢复。

## 验收

- [ ] 清库工具在目标 Firebase 项目只读盘点，确认目标项目和业务文档数量。
- [ ] 执行清理后重新盘点，两类业务文档均为零。
- [ ] Firebase Authentication 用户仍可登录，邮箱验证规则正常。
- [ ] 新设备/新账号首次同步能从本地数据创建快照。
- [ ] 两台设备的提示词、目录、偏好和删除标记正确同步。
- [ ] UID 隔离、并发冲突、服务端写入配额和本地备份恢复测试通过。
- [ ] 真实 Firebase 和双设备验收完成后才允许合并发布。

生产 Firebase 清库尚未执行；CI 仅对 Firestore Emulator 运行自动化测试。
