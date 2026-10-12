---
kind: upgrade-guide
description: "PI-AI 的空模型列表现在会选择已安装的提供商目录。"
---

# PI-AI 空模型列表

[English](guide.md) | 中文

## 变更

对于 `@deepseek-ai/dsh-llm-pi-ai`，提供商配置中的 `models: []` 以前不会公开任何模型。现在，空列表会使用已安装的提供商目录，与省略 `models` 字段的行为一致。非空列表仍将该路由限制为配置的模型。这会影响通过空列表隐藏提供商路由的自定义配置和覆盖文件。

## 迁移

1. 在 `cordis.yml` 或其覆盖文件中 PI-AI 插件的 `config.providers` 映射内，保留 `models: []` 或省略 `models` 可使用已安装的目录。使用非空的 `models` 列表可限制可用模型。如果某个路由必须保持不可用，请从 `providers` 中移除该提供商条目。
2. 重启配置并打开设置 → 模型。确认显示的提供商路由和模型列表符合预期。
