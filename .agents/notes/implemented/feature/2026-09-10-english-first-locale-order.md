# Agent Note: English-first locale ordering

Status: implemented

English | [中文](2026-09-10-english-first-locale-order.zh.md)

## Problem

fi presents English as its primary language: the served markup declares `en`, every dictionary fallback chain terminates at `FALLBACK_LOCALE` (`en`), the docs are English-canonical, and the CLI, desktop host, and website are English-only. The Settings Language row still listed 中文 first, because `LOCALE_IDS` carried `zh` before `en` and the shipped-catalog order flows straight through `snapshot.locales` into the row's option list. The one surface where English was not first was the surface where the user chooses a language.

## Decision

`LOCALE_IDS` in `packages/client/locale/src/locale-settings.ts` is now `['en', 'zh']`. The shipped catalog, the locale snapshot, and the Language row derive their display order from that constant, so English now lists first and 中文 second. Nothing else moves: the browser-derived initial locale, the `en` fallback terminus, dictionary registration, and the complete `zh` translations are unchanged. A Chinese-language browser or system still opens in Chinese, and the explicit Host preference keeps working as before.

## Alternatives considered

**Dropping the `zh` dictionaries.** `scripts/locale-dictionary-parity.spec.ts` requires symmetric `zh`/`en` key sets, registration enforces bilingual balance, and the doc lane enforces README pairing. Removing Chinese would break every gate and guarantee merge conflicts against upstream for hundreds of files.

**Defaulting to English regardless of the browser.** That would reverse upstream's documented browser-derived initial-locale decision and its e2e pins, diverging behavior for Chinese-reading users without a product reason. fi follows the system language; English is primary in ordering, fallback, and docs, not by overriding the reader's own browser statement.

**Sorting the Language row by label.** Display order belongs to the shipped-catalog declaration (`LOCALE_IDS`), not to a row-local sort; a sort would also reorder external language-pack contributions that declare their own registration order.

## Consequences

The Language row lists English first; `snapshot.locales` is en-first for every consumer. No positional indexing of the catalog exists, so only the four spec lines that pin the order changed with the constant. Upstream merges touch one line of source plus its comment.
