---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-11-fi-title-reasoning

English | [中文](2026-10-11-fi-title-reasoning.zh.md)

## Summary

Records the resolved reasoning effort for auxiliary session-title requests when the selected model exposes one.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-11-fi-title-reasoning
baseline: false
changes:
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "1cb6437add22641c189dc8391565e6bec6217f3530f632eef999f20767307689"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The optional reasoningEffort field preserves existing Session records and the current format version. Providers choose controls from captured model metadata; the logged request matches dispatch. Existing committed format generations remain unchanged.

<a id="verification"></a>
## Verification

Focused LLM service, session-title executor, first-prompt provider, all-prompts provider, and title service lifecycle tests pass. Tests cover omitted effort, captured adapter controls, supersession, and current-title snapshots.

<a id="dev-note"></a>
## Dev Note

None.
