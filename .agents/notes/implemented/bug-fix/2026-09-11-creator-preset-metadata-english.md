# Agent Note: Creator preset metadata stays English

Status: implemented

English | [中文](2026-09-11-creator-preset-metadata-english.zh.md)

## Problem

Creator mode starts an authored preset by copying a shipped preset. The copy operation preserves the source description, but the shipped `preset.yml` files used Chinese source metadata. A Creator session could therefore produce an English-named preset whose picker entry ended with a Chinese description.

## Decision

Shipped `preset.yml` files use English source names and descriptions. Client dictionaries continue to localize built-in rows without changing those source files. The `editing-cordis-compositions` skill requires Creator mode to leave both `name` and `description` in English after it finishes an authored preset.

Copying a user-authored preset still preserves its authored description. The roster does not reject non-English metadata outside Creator mode.

## Alternatives considered

**Translate metadata inside `copy()`.** The Host operation has no reader locale, and selecting a client locale there would make CLI, SDK, and headless copies depend on UI state.

**Delete the copied description.** An empty description would remove useful guidance from the new picker row before Creator mode finishes the edit.

**Reject non-ASCII user metadata.** Character-set validation would reject legitimate user-authored names and would impose the Creator-mode preference on every preset root.

## Consequences

Copies of shipped presets start with English metadata, and Creator mode explicitly replaces that metadata with an English description of the finished preset. Chinese clients still render localized names and descriptions for the shipped rows. Existing user preset files are not rewritten.
