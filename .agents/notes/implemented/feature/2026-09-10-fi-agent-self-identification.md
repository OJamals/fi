# Agent Note: fi agent self-identification

Status: implemented

English | [中文](2026-09-10-fi-agent-self-identification.zh.md)

## Problem

The fixed first-party system-prompt opener named the upstream product: every session opened with `You are an AI agent powered by DeepSeek Harness.` (the `harness:identity` section, `includeHarnessIdentity`, default true). fi sessions therefore introduced the model as a DeepSeek Harness agent, so the model self-identified with the upstream name inside a fi-branded application.

## Decision

The fixed identity opener now reads `You are an AI agent powered by fi.` The section name (`harness:identity`), its order constant (`HARNESS_IDENTITY`), the `includeHarnessIdentity` config contract, and the sdk-minimal override that disables the section are unchanged. Every other surface keeps its existing naming: `dsh` commands, `@deepseek-ai/dsh-*` package names, `$DSH_HOME`, wire identities, and attribution in the root documentation still name DeepSeek Harness where they identify the implementation rather than the product speaking.

## Alternatives considered

**Naming the implementation in the opener (`... powered by fi, built on DeepSeek Harness`).** The opener is identity prose the model echoes when asked what it is; provenance belongs to licensing and documentation, which already carry it.

**Dropping the section entirely.** The section anchors the prompt's opening voice for every deployment that does not override it; removing it changes every default session for no gain.

**Suppressing the identity in fi bundles via `includeHarnessIdentity: false`.** That flag exists for compatibility deployments that own the complete prompt; using it here would lose the default opener instead of restating it.

## Consequences

The model self-identifies as fi in every default session. The sentence was pinned by the system-prompt, persona, app-boot, agent-loop, tool-fs, tool-fs-search, and tool-web specs, the web replay e2e, and the recorded session snapshots; all were restated together. Upstream merges touch one source line plus the same restatement in whatever pins it that release carries.
