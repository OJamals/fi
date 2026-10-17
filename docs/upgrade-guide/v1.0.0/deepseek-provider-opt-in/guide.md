---
kind: upgrade-guide
description: "FI profiles require explicit opt-in to the DeepSeek API-key provider."
---

# DeepSeek API-key provider opt-in

English | [中文](guide.zh.md)

## Change

FI's shared runtime bundle defaults `llm-deepseek.enabled` to `false`. Fresh profiles no longer show an unconfigured DeepSeek provider in Models. Existing explicit `enabled: true` settings remain effective. Users who previously relied on the inherited enabled default, including those supplying only `DEEPSEEK_API_KEY`, must enable the route before using it. Credentials and saved conversations are not deleted.

## Migration

1. To use DeepSeek, open **Settings → Models → Add model provider** and add it, or set `llm-deepseek.enabled: true` in the profile's settings. Keep your existing credential configuration.
2. Confirm DeepSeek appears in Models and select an available model. Existing conversations using a disabled route need an enabled route or another model before their next message.
3. To use another provider, leave DeepSeek disabled and configure that provider normally.
