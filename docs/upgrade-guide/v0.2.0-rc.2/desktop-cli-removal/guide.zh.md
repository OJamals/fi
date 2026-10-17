---
kind: upgrade-guide
description: "fi Desktop 不再提供内置 dsh 终端命令及其管理菜单。"
---

# 移除 Desktop 终端命令

[English](guide.md) | 中文

## 变更

fi Desktop 不再提供终端启动器和**管理 dsh 命令…**菜单。指向应用内部的现有终端命令注册会在升级后失效。Desktop Host 继续使用共享的 profile 运行时。会话、设置、凭据和独立 CLI 安装保持不变。

## 迁移

1. 升级前，在旧应用中打开**管理 dsh 命令… → 移除**对话框，取消注册终端命令并恢复此前被替换的启动器。
2. 终端工作流使用独立 [CLI](../../../../apps/cli/README.zh.md)。Desktop 插件通过应用中的插件页面管理。
3. 升级后，确认 Desktop 能打开现有会话，应用菜单不再提供命令管理。如果升级前未取消注册旧命令，请先检查其目标，再移除失效链接或 PATH 条目；不要删除其他安装或其保存的备份。
