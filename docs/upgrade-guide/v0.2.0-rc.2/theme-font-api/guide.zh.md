---
kind: upgrade-guide
description: "主题扩展写入字号时需选择字体角色，并从快照读取各角色的字号。"
---

# 在主题扩展中选择字体角色

[English](guide.md) | 中文

## 变更

浏览器主题服务将 `setFontSize(px)` 替换为 `setFontSize(role, px)`，并将 `ThemeSnapshot.fontSize` 替换为 `ThemeSnapshot.fontSizes`。角色包括 `text`、`code` 和 `terminal`。调用该服务或读取其快照的自定义客户端插件必须更新。现有用户配置仍以 `fontSize` 保存会话正文字号，无需迁移设置文件。

## 迁移

1. 在自定义客户端插件中，将现有正文字号控件的 `ctx.theme.setFontSize(px)` 替换为 `ctx.theme.setFontSize('text', px)`。
2. 将快照中的 `fontSize` 读取替换为 `fontSizes.text`。使用 `fontSizes.code` 和 `fontSizes.terminal` 读取独立字号，使用 `fontFamilies` 读取规范化的字体列表。
3. 重新构建插件，修改各项字体设置，再次打开设置，确认所选值已持久化且终端输出仍然可见。
