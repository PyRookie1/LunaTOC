# 更新记录

## 1.0.2

- 修复自定义 Prompt 编辑器数字输入和粘贴事件被 ChatGPT 页面全局监听器干扰的问题，增加 Closed Shadow DOM 输入事件隔离。
- 修复 Markdown 粗体标记跨多个相邻 DOM Text Node 拆分时无法正确渲染的问题，兼容流式输出。
- 移除自动隐藏 ChatGPT「已分析」状态行的功能，恢复由 ChatGPT 原生控制该状态的显示行为。
- 完善自动发布流程：通过 CI 验收后自动生成版本化扩展 ZIP、SHA-256 校验文件并发布 GitHub Release。
- 完成真实 Firebase 邮箱密码认证、Firestore 安全规则、双设备云同步及真实浏览器验收。


## 1.0.0

LunaTOC 初始版本，包含：

- ChatGPT 对话目录、目录搜索和当前问题跟踪。
- 回答标题提取、标题导航和活动分支识别。
- 自定义目录名称及账号隔离。
- ChatGPT Markdown 粗体修复。
- Tips 提示词库、主题与侧边栏布局设置。
- 本地数据备份与恢复。
- 由 LunaTOC 维护者统一提供的可选 Firebase 邮箱密码云同步：默认关闭，首次注册需验证邮箱；每个 ChatGPT 账号必须主动绑定所选 LunaTOC 云账号，其他本地账号不得自动上传；提供按设置字段合并、数据冲突保护、删除保护及安全规则。
- 类型检查、模拟页面浏览器验收、Firebase REST 模拟测试及真实 Firestore 规则模拟器验证、扩展构建和依赖安全检查。

云同步在发布前仍需使用真实 Firebase Spark 项目完成身份、安全规则和跨设备联调。详见 [发布验收清单](docs/RELEASE_CHECKLIST.md)。

