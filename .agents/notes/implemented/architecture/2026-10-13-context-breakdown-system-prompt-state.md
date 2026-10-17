# Agent Note: Context breakdown retains only system prompts

Status: implemented

English | [中文](2026-10-13-context-breakdown-system-prompt-state.zh.md)

## Problem

`contextBreakdown` previously kept a price and system classification for every retained surface node. Its checkpoints and per-event array copies therefore grew with the message count, even though compaction events already record the replaced range's heuristic price.

## Decision

[`breakdown-projection.ts`](../../../../packages/llm/token-meter/src/breakdown-projection.ts) retains the surviving `system/message` nodes in surface order with their heuristic prices, one running surface total, and at most one armed shadow-price claim. State version 6 discards version-5 rows; other projection keys keep their rows.

- An append adds its price; a `system/message` append also joins the end of the system list.
- `compaction/summary` and `compaction/prune` arm a claim from `shadowedRange`, `shadowedTokenCount`, and the retained system prompts named by `shadowedSeqs`. The next event consumes or expires it. A replacement over the claimed range subtracts the claim price and drops those prompts; a replacement naming another range, or putting a `system/message` in place of a metered range, throws.
- An unmetered replacement of one retained system prompt subtracts that prompt's own price. A `system/message` replacement keeps its position; any other replacement removes it.
- Any other unmetered replacement folds at zero delta, the rule `contextPressure` already applies.

`systemTokens` is the last retained prompt with a positive price, and `messageTokens` is the surface total minus it; both are floored at zero. `shadowedSeqs` is the authoritative set of shadowed nodes, so membership decides which prompts leave without locating non-system endpoints in surface order.

## Verification

Local token-meter tests exercise bounded state, metered summary and prune replacements, system rewrites, claim expiry, and checkpoint restoration. No local corpus size or speed improvement is claimed.

## Alternatives considered

**Keep per-node entries with a faster validator.** Faster validation still retains per-message rows, O(surface) array copies, and checkpoint writes proportional to the message count.

**Columnar per-node entries.** Parallel arrays still keep O(surface) state for information the shadow-price events already carry.

**Exact pricing of unmetered non-system replacements.** That requires per-node prices. Current producers meter every non-system replacement, and released formats from v0 carry the shadow-price fields, so the remaining case is a log that breaks producer adjacency; it drifts like `contextPressure`.

## Consequences

Checkpoint size and per-event cost follow the number of surviving system prompts rather than messages, and cached listings no longer validate per-message entries. The figures stay exact for metered replacements and system-prompt rewrites, and their sum equals the `measure()` heuristic total under those producers. An unmetered non-system replacement leaves the figures off by that replacement's price difference. A future range replacement that inserts a system prompt is rejected until the fold can order it among the retained prompts. This supersedes the positional-entry choice for this unit in the [in-history system-prompt replacement](../feature/2026-09-02-in-history-system-prompt-replacement.md) note; `measure()` keeps positional nodes for route pricing.
