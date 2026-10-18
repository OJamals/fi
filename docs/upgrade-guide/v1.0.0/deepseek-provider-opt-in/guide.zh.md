---
kind: upgrade-guide
description: "FI profile 需要显式启用 DeepSeek API-key 提供方。"
---

# 显式启用 DeepSeek API-key 提供方

[English](guide.md) | 中文

## 变更

FI 共享运行时 bundle 禁用旧版 `llm-deepseek` 插件。其 `deepseek-official` 路由不再出现在第三方选择器中；pi-ai 的 `deepseek` 提供方仍然可用。仅设置 `llm-deepseek.enabled: true` 不会启用已禁用的插件。凭据和已保存的对话不会被删除。

## 迁移

1. 如需配置 API 密钥，请打开 **设置 → 模型 → 添加模型提供商** 并选择 `deepseek`。
2. 如需保留旧版 `deepseek-official` 路由，请在 profile 的 `cordis.patch.yml` 中添加以下条目并重启应用。保留现有凭据；若此前在设置中禁用了该路由，请重新启用。

```yaml
- id: llm-deepseek
  disabled: false
```

3. 确认所选提供方出现在 Models 中，并在使用已禁用路由的对话发送下一条消息前选择可用模型。
