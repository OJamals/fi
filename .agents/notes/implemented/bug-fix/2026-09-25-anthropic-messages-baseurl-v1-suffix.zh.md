# Agent Note: Anthropic Messages baseURL 的 /v1 后缀

Status: implemented

[English](2026-09-25-anthropic-messages-baseurl-v1-suffix.md) | 中文

## 问题

设置界面的 baseURL 占位符引导用户采用 OpenAI 风格约定，即以 `/v1` 结尾的根路径。pi-ai 的 Anthropic SDK 封装会将 `/v1/messages` 原样追加到 route 配置的 baseURL 上，因此按该引导写法配置的 `anthropic-messages` route 会请求 `/v1/v1/messages`，导致每次请求都 404。`dsh-llm-pi-ai` 自身的模型列表 discovery（`discovery.ts`）已经为其 `GET /v1/models` 探测规范化了同样被引导出的后缀；而 `catalog.ts` 中真正为模型请求打上 baseURL 的 `resolveRouteModels` 并未处理。

## 决策

`catalog.ts` 导出 `protocolBaseUrl(api, baseUrl)`，在 `resolveRouteModels` 中已知模型 api 之后解析其 baseURL 的唯一位置调用。对于 `anthropic-messages`，它去除尾部斜杠以及一个尾部的 `/v1` 段（大小写不敏感）；其他协议的 baseURL 原样返回，因为 OpenAI 风格 SDK 需要被给予的那个 `/v1`。这与 `dsh-llm-deepseek` 的 `messagesApiRoot` 是不同的修复：后者在配置的根路径缺失 `/v1` 时为 DeepSeek 自己的 Messages API *追加* `/v1`——两个包分别在相反方向规范化不同协议，并不共享同一个 helper。

## 备选方案

- **在 pi-ai 内部规范化。** 否决：pi-ai 是第三方 vendored client；本 harness 只能控制交给 pi-ai Anthropic 封装的 baseURL 本身。
- **对所有协议都做规范化。** 否决：OpenAI 风格协议的 baseURL 按原样使用，内部不插入 `/v1`；对其去除会破坏一个本已正确配置的 route。

## 后果

无论 `anthropic-messages` route 配置的是被引导出的 `/v1` 后缀写法还是裸根路径，现在都会请求同一个端点。`discovery.ts` 的 listing URL 规范化与本次 catalog 解析规范化，分别为两种不同的请求（模型列表 vs 模型请求）解决同一个被引导出的写法问题；若任一协议的端点约定发生变化，两处都必须同步维护。
