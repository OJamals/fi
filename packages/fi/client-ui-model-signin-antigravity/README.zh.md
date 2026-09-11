# @fi/client-ui-model-signin-antigravity

[English](README.md) | 中文

模型页面 Antigravity 登录卡片，为 fi 的模型设置页面添加 Antigravity 登录功能。

## Table of Contents

- [Summary](#summary)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Summary

`@fi/client-ui-model-signin-antigravity` 为模型设置页面添加 Antigravity OAuth 登录。它在页面页脚槽位渲染，运行 Google PKCE 对话，并在成功后链接 Host 的 `adopt` 以创建路由并枚举模型。

## What it does

- 注册到 `settings.models.footer` 槽位
- 当流程已注册且无存储授权时，提供“使用 Antigravity (Gemini Code Assist) 登录”
- 运行 OAuth 对话：通知（待打开的 URL）、提示（粘贴代码）、终态结果
- 成功后链接 `adopt('fi-antigravity/antigravity')` 以创建路由并列出模型
- 当授权已存储时显示“移除登录”，使用 `revoke`

## How it works

该插件自行挂载 `authorization` Remote 命名空间（应用 Remote 拥有方的客户端仅挂载精选命名空间列表），然后进入一个在 inject 中列出该命名空间的作用域 fiber。它通过 `slots.inject()` 注册到 `settings.models.footer` 槽位，等待模型区块声明该槽位。

## Model Experience

用户在模型页面看到提供 Antigravity 登录的页脚区域。单击后在浏览器中打开 Google OAuth URL，等待回环回调，成功后显示路由结果以及该路由现在提供的模型。

## Known Limitations and Deferred Work

- 卡片仅出现在页脚；Antigravity 不在 pi-ai 目录中，因此没有可扩展的 pi-ai 提供方卡片。
- OAuth 流程需要浏览器（回环回调）。无头环境需要手动模式。
- 卡片的 store 与 pi-ai 卡片的 store 分离；两者可同时激活。
