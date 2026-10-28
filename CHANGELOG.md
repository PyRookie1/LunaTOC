# 更新记录

## 1.0.0

LunaTOC 初始版本，包含：

- ChatGPT 对话目录、目录搜索和当前问题跟踪。
- 回答标题提取、标题导航和活动分支识别。
- 自定义目录名称及账号隔离。
- ChatGPT Markdown 粗体修复。
- Tips 提示词库、主题与侧边栏布局设置。
- 本地数据备份与恢复。
- 可选 Firebase Spark 云同步（手动触发）：独立 Firebase 身份认证、按 ChatGPT 账号隔离、三方冲突合并、删除保护及安全规则。
- 类型检查、模拟页面浏览器验收、Firebase REST 模拟测试、扩展构建和依赖安全检查。

云同步在发布前仍需使用真实 Firebase Spark 项目完成身份、安全规则和跨设备联调。详见 [发布验收清单](docs/RELEASE_CHECKLIST.md)。

