# @fi/llm-antigravity

[English](README.md) | 中文

Antigravity OAuth 适配器与 Cloud Code 传输，为 fi 提供 Antigravity 登录与推理能力。

## Table of Contents

- [Summary](#summary)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Summary

`@fi/llm-antigravity` 为 fi 添加 Antigravity OAuth 登录。持有具备 Antigravity 访问权限的 Google 账户的用户可登录一次，适配器将发现其 Cloud Code 项目、存储授权，并通过付费的 Cloud Code 端点路由推理请求。

## What it does

- 在 `ctx.authorization` 上注册 `fi-antigravity/antigravity` 流程
- 运行 Google PKCE OAuth 流程（浏览器 → 回环回调 → 令牌交换 → 项目发现）
- 将授权存储在 fi 的凭据存储中，键为 `fi-antigravity/antigravity`
- 提供 Cloud Code 传输：带有 Antigravity envelope 的 `streamGenerateContent`

## How it works

OAuth 流程使用 Antigravity 桌面应用的公共客户端 id，回环重定向到 `127.0.0.1:54545`，以及五个 scope（含 `cloud-platform` 与 `cclog`）。交换后通过 `loadCodeAssist` 发现 `cloudaicompanionProject`，它成为每个推理请求所命名的计费项目。

传输将 Gemini `contents`/`generationConfig` 包装进 Cloud Code envelope（`{project, model, request, userAgent: "antigravity", requestId, requestType: "agent"}`），并 POST 到 `v1internal:streamGenerateContent?alt=sse`。

**运行时不变量：** 未发布 invariant companion。流程每次尝试的 PKCE verifier 与回环服务器在该次尝试自身的运行内创建并拆除；只有已提交的授权会持久保留。

## Model Experience

无，因为该包仅注册 OAuth 流程与授权，未挂载模型适配器，也不组装请求。

#### KV Cache 影响

无；传输模块尚未接入请求路径，因此不会发送推理请求。

## Known Limitations and Deferred Work

- OAuth 流程需要浏览器（回环回调）。无头环境需要 `--manual` 模式或预授权令牌文件。
- 传输尚未接入 fi 的 `llm.discoverModels`——路由由授权控制器的 `adopt` 创建，但模型枚举需要 Host 的 LLM 服务识别 `antigravity` 提供方 id。
- Stealth 刻意保持最小：UA 字符串与发现请求中的 `ideType: "ANTIGRAVITY"` 是仅有的身份声明，均为捕获派生。
