---
kind: upgrade-guide
description: "FI profile 需要显式启用 DeepSeek API-key 提供方。"
---

# 显式启用 DeepSeek API-key 提供方

[English](guide.md) | 中文

## 变更

FI 共享运行时 bundle 将 `llm-deepseek.enabled` 默认设为 `false`。新 profile 的 Models 中不再显示未配置的 DeepSeek 提供方。已有的显式 `enabled: true` 设置仍然生效。此前依赖继承的启用默认值的用户，包括仅提供 `DEEPSEEK_API_KEY` 的用户，需要先启用路由。凭据和已保存的对话不会被删除。

## 迁移

1. 如需使用 DeepSeek，请打开 **设置 → 模型 → 添加模型提供商** 添加，或在 profile 设置中设置 `llm-deepseek.enabled: true`。保留现有凭据配置。
2. 确认 DeepSeek 出现在 Models 中并选择可用模型。使用已禁用路由的已有对话，必须启用该路由或选择另一模型后才能发送下一条消息。
3. 如需使用其他提供方，保持 DeepSeek 禁用并按正常流程配置其他提供方。
