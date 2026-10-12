---
kind: upgrade-guide
description: "Theme extensions select a font role when writing sizes and read per-role sizes from snapshots."
---

# Select font roles in theme extensions

English | [中文](guide.zh.md)

## Change

The browser theme service replaces `setFontSize(px)` with `setFontSize(role, px)` and replaces `ThemeSnapshot.fontSize` with `ThemeSnapshot.fontSizes`. Roles are `text`, `code`, and `terminal`. Custom client plugins that call the service or read its snapshots must update. Existing user configuration retains the `fontSize` key for conversation text; no settings-file migration is required.

## Migration

1. In custom client plugins, replace `ctx.theme.setFontSize(px)` with `ctx.theme.setFontSize('text', px)` for existing text-size controls.
2. Replace snapshot reads of `fontSize` with `fontSizes.text`. Use `fontSizes.code` and `fontSizes.terminal` for the independent sizes, and `fontFamilies` for normalized family lists.
3. Rebuild the plugin, change each font setting, and reopen Settings to confirm that the selected values persist and terminal output remains visible.
