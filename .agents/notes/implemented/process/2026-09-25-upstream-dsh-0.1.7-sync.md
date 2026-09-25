# Agent Note: Upstream DeepSeek Harness 0.1.7 sync

Status: implemented

English | [中文](2026-09-25-upstream-dsh-0.1.7-sync.zh.md)

## Problem

FI forked DeepSeek Harness on 2026-09-10, after the DSH 0.1.5 release line. Upstream `master` at tag `dsh-v0.1.7-rc.2` carries 3511 further commits, including Session format V4, tool-role messages, the volatile Config settings forms, profile-YAML Agent presets, DeepSeek Messages protocol support, MCP resources, Auto review, persistent Schedule, and job-seam consolidation. FI's own packages and product deltas must keep working on top of them.

## Decision

FI merges upstream `master` with a merge commit, takes upstream structure and behavior, and re-applies FI deltas on the new APIs:

- Package manifests keep FI's version line and `OJamals/fi` repository URL; workspace specifiers follow upstream's `workspace:*` (DSH) and `workspace:~` (vendor) rule.
- `llm-pi-ai` adopts tool-role messages and `requiredImageOffload`/`projectOffloadedImages`; assistant images still replay as fallback text instead of failing the request.
- `@fi/llm-antigravity` and `@fi/web-search-preferences` replace the removed `settings.installSection` with volatile plugin Config. Their settings namespaces are their profile entry ids `fi-antigravity` and `fi-web-search-preferences`; the latter's preferences previously stored under `web-search-deepseek` are not carried over.
- `@fi/client-ui-web-search-preferences` registers into upstream's `plugins.item` slot through `ctx.configForms`.
- Model-universal onboarding keeps `model-setup` in place of the deleted DeepSeek key dialog; the DeepSeek account menu's API-key action opens `model-setup`.
- The Desktop electron-builder entry wraps upstream's shared factory and re-applies FI identity and the GitHub Releases production channel; the macOS updater config helper accepts a GitHub feed.

## Alternatives considered

**Cherry-pick selected upstream commits.** Upstream refactors cross packages (message model, settings forms, Session format), so partial picks would not compile and would diverge further on each later sync.

**Rebase FI commits onto upstream.** Rewriting FI history offers no benefit over one merge commit and loses the record of which delta was re-applied where.

## Consequences

FI now runs Session format V4 and migrates V3 Session data on first open. Upstream's view-only Agent preset page replaces FI's preset copy/delete tests. Upstream's new Desktop icon and tray PNGs are DeepSeek artwork until FI replaces them. Four unit tests fail identically on pristine upstream on macOS hosts (Windows path resolution, Python temp directory, two Schedule time-zone cases) and are not merge regressions.
