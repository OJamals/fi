# Agent Note: fi 智能体自我标识

Status: implemented

[English](2026-09-10-fi-agent-self-identification.md) | 中文

## 问题

固定的第一方系统提示词开场白此前使用上游产品名：每个会话都以 `You are an AI agent powered by DeepSeek Harness.` 开头（`harness:identity` 节，`includeHarnessIdentity`，默认开启）。fi 的会话因此把模型介绍为 DeepSeek Harness 智能体，模型在 fi 品牌的应用内以上游名称自我标识。

## 决策

固定开场白现为 `You are an AI agent powered by fi.`。节名（`harness:identity`）、顺序常量（`HARNESS_IDENTITY`）、`includeHarnessIdentity` 配置契约，以及禁用该节的 sdk-minimal 覆盖均保持不变。其余表面保留既有命名：`dsh` 命令、`@deepseek-ai/dsh-*` 包名、`$DSH_HOME`、线上协议身份，以及根文档中的署名，在标识底层实现而非发声产品之处仍使用 DeepSeek Harness。

## 备选方案

**在开场白中同时命名实现（`... powered by fi, built on DeepSeek Harness`）。** 开场白是模型被问及身份时复述的自我陈述；出处属于许可与文档，那里已经载明。

**彻底删除该节。** 该节为所有未覆盖它的部署锚定提示词的开场语气；删除会无谓地改变每个默认会话。

**在 fi bundle 中用 `includeHarnessIdentity: false` 压制标识。** 该开关是为拥有完整提示词的兼容性部署准备的；在此使用会失去默认开场白而非改写它。

## 后果

模型在每个默认会话中以 fi 自我标识。该句被 system-prompt、persona、app-boot、agent-loop、tool-fs、tool-fs-search 与 tool-web 的测试、web replay e2e 以及录制的会话快照固定；以上已一并改写。与 upstream 的合并只触及一行源码，以及该版本中固定此句的对应测试。
