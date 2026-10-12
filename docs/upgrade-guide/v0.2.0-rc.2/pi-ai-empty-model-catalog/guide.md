---
kind: upgrade-guide
description: "An empty PI-AI model list now selects the installed provider catalog."
---

# PI-AI empty model lists

English | [中文](guide.zh.md)

## Change

For `@deepseek-ai/dsh-llm-pi-ai`, a provider profile with `models: []` previously exposed no models. An empty list now uses the installed provider catalog, matching an omitted `models` field. A nonempty list still restricts the route to its configured models. This affects custom profiles and overlays that used an empty list to hide a provider route.

## Migration

1. In the PI-AI plugin's `config.providers` mapping in `cordis.yml` or its overlay, keep `models: []` or omit `models` to use the installed catalog. Use a nonempty `models` list to restrict the available models. Remove the provider entry from `providers` if that route must remain unavailable.
2. Restart the profile and open Settings → Models. Confirm that the intended provider routes and model lists appear.
