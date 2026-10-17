---
kind: upgrade-guide
description: "Custom non-system replacements need adjacent metering events to update context breakdown totals."
---

# Meter custom context replacements

English | [中文](guide.zh.md)

## Change

`contextBreakdown` now retains system prompts and aggregate prices instead of a price for every message. Its checkpoint version changes from 5 to 6; older cached rows are discarded and rebuilt from the session log. Session logs and other projection keys remain unchanged.

Custom producers that replace a non-system range without an immediately preceding `compaction/summary` or `compaction/prune` event now leave the breakdown total unchanged. Built-in metered compaction and single-system-prompt rewrites retain their existing estimates.

## Migration

1. Keep existing session logs; no manual cache deletion or log rewrite is needed.
2. For custom replacement producers, use the compaction service or emit the matching measurement immediately before the replacement. Its `shadowedRange`, `shadowedSeqs`, and `shadowedTokenCount` must describe the actual replaced surface using the token meter's fixed heuristic.
3. Replay a representative custom replacement and compare `contextBreakdown.systemTokens + contextBreakdown.messageTokens` with the sum of `tokenMeter.measure(session).nodes[].heuristicTokens`. Include checkpoint restoration in the producer's tests.
