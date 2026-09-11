# Agent Note: Creator preset 元数据保持英文

Status: implemented

[English](2026-09-11-creator-preset-metadata-english.md) | 中文

## Problem

Creator 模式通过复制随附 preset 来开始创作。复制操作会保留来源描述，但随附的 `preset.yml` 文件使用中文源元数据。因此，Creator 会话可能产出名称为英文、选择器条目结尾却带中文描述的 preset。

## Decision

随附 `preset.yml` 文件使用英文源名称与描述。客户端字典继续本地化内置条目，而不更改这些源文件。`editing-cordis-compositions` skill 要求 Creator 模式完成创作后，`name` 与 `description` 均保持英文。

复制用户创作的 preset 时，仍会保留其已创作描述。Roster 不会拒绝 Creator 模式之外的非英文元数据。

## Alternatives considered

**在 `copy()` 内翻译元数据。** Host 操作没有读者 locale；在此选择客户端 locale 会让 CLI、SDK 与 headless 复制依赖 UI 状态。

**删除复制的描述。** 空描述会在 Creator 模式完成编辑前，从新选择器条目中移除有用说明。

**拒绝非 ASCII 用户元数据。** 字符集验证会拒绝合法的用户创作名称，并把 Creator 模式的偏好强加给每个 preset 根目录。

## Consequences

随附 preset 的副本以英文元数据开始，Creator 模式也会明确把该元数据替换成描述最终 preset 的英文说明。中文客户端仍为随附条目呈现本地化名称与描述。既有用户 preset 文件不会被改写。
