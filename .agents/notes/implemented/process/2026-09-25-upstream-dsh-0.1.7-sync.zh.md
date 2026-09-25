# Agent Note：同步上游 DeepSeek Harness 0.1.7

Status: implemented

[English](2026-09-25-upstream-dsh-0.1.7-sync.md) | 中文

## 问题

FI 于 2026-09-10 在 DSH 0.1.5 发布线之后从 DeepSeek Harness 分叉。上游 `master` 的标签 `dsh-v0.1.7-rc.2` 又包含 3511 个提交，其中有 Session 格式 V4、tool 角色消息、volatile Config 设置表单、profile YAML 形式的 Agent 预设、DeepSeek Messages 协议支持、MCP 资源、Auto review、持久化 Schedule 以及 job seam 整合。FI 自有的包与产品差异必须在这些变化之上继续工作。

## 决定

FI 以合并提交合入上游 `master`，采用上游的结构与行为，再在新 API 上重新应用 FI 差异：

- 包清单保留 FI 的版本线与 `OJamals/fi` 仓库地址；workspace 依赖范围遵循上游规则，DSH 包用 `workspace:*`，vendor 包用 `workspace:~`。
- `llm-pi-ai` 采用 tool 角色消息与 `requiredImageOffload`/`projectOffloadedImages`；assistant 图片仍以回退文本回放，而不是让请求失败。
- `@fi/llm-antigravity` 与 `@fi/web-search-preferences` 用 volatile 插件 Config 取代已删除的 `settings.installSection`。它们的设置命名空间是各自的 profile 条目 id `fi-antigravity` 与 `fi-web-search-preferences`；后者此前存放在 `web-search-deepseek` 下的偏好不会迁移。
- `@fi/client-ui-web-search-preferences` 通过 `ctx.configForms` 注册到上游的 `plugins.item` 插槽。
- 模型通用的新手引导保留 `model-setup`，替代已删除的 DeepSeek 密钥对话框；DeepSeek 账户菜单的 API 密钥操作打开 `model-setup`。
- Desktop 的 electron-builder 入口包装上游共享工厂，并重新应用 FI 身份与 GitHub Releases 正式发布通道；macOS 更新配置辅助函数接受 GitHub 源。

## 考虑过的替代方案

**挑选部分上游提交。** 上游重构跨越多个包（消息模型、设置表单、Session 格式），部分挑选无法编译，且每次后续同步都会进一步偏离。

**将 FI 提交变基到上游之上。** 重写 FI 历史相比一个合并提交没有收益，还会丢失各项差异在何处重新应用的记录。

## 影响

FI 现在运行 Session 格式 V4，并在首次打开时迁移 V3 Session 数据。上游只读的 Agent 预设页面取代了 FI 的预设复制/删除测试。上游新的 Desktop 图标与托盘 PNG 仍是 DeepSeek 图稿，直到 FI 替换它们。有四个单元测试在 macOS 主机上的原始上游中以相同方式失败（Windows 路径解析、Python 临时目录、两个 Schedule 时区用例），并非合并回归。
