---
kind: upgrade-guide
description: "FI profiles require explicit opt-in to the DeepSeek API-key provider."
---

# DeepSeek API-key provider opt-in

English | [中文](guide.zh.md)

## Change

FI's shared runtime bundle disables the legacy `llm-deepseek` plugin. Its `deepseek-official` route no longer appears in the third-party selector; pi-ai's `deepseek` provider remains available. Existing `llm-deepseek.enabled: true` settings alone do not enable a disabled plugin. Credentials and saved conversations are not deleted.

## Migration

1. For API-key setup, open **Settings → Models → Add model provider** and choose `deepseek`.
2. To retain the legacy `deepseek-official` route, add the following entry to your profile's `cordis.patch.yml`, and restart the application. Keep your existing credentials; if you previously disabled the route in settings, enable it again.

```yaml
- id: llm-deepseek
  disabled: false
```

3. Confirm your chosen provider appears in Models and select an available model before sending another message in a conversation that used the disabled route.
