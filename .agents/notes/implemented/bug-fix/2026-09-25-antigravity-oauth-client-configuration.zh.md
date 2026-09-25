# Agent Note: Antigravity OAuth 客户端 id 与密钥迁移至凭据接缝

Status: implemented

[English](2026-09-25-antigravity-oauth-client-configuration.md) | 中文

## 问题

`packages/fi/llm-antigravity/src/auth/compat.ts` 曾将 Antigravity CLI 的 Google 已安装应用 OAuth 客户端 id 与密钥作为仓库字符串字面量分发，由 `oauth.ts` 的模块级配置读取，并可用环境变量覆盖。`packages/fi/provider-compat/src/provider-settings.json` 在 `antigravityCli.oauth.clientId` 处第二次携带了相同的客户端 id，由供应商更新工具（`scripts/vendor/auth2api/update-provider-settings.mjs`）在每次同步时重新生成——fi 自身代码从未读取过这份副本，它只是重复了该字面量而未加以使用。GitHub 密钥扫描会把 Google 的 `\d+-[a-z0-9]+\.apps\.googleusercontent\.com` 客户端 id 与 `GOCSPX-` 密钥等同于已泄露的凭据来标记：这个 OAuth 客户端用于对 Google 账户系统认证每一次 Antigravity 登录，因此它出现在 git 历史中即构成持续暴露。

## 决定

- 字面量的客户端 id 与密钥已从 `compat.ts` 移除。`oauth.ts` 中与 Google 通信的每个函数（`generateAntigravityAuthURL`、`exchangeAntigravityCode`、`refreshAntigravityTokens`）改为显式接收一个 `AntigravityOAuthClient { clientId, clientSecret }` 参数，而不是读取模块级配置。
- `index.ts` 在每次操作时都通过凭据接缝解析这两个值：`resolveAntigravityOAuthClient(ctx, refs)` 在凭据服务已挂载时调用 `ctx.credentials.resolve(ref)`，否则回退到 `launchEnvironmentOf(ctx).get(ref)?.value`——这与 `llm-pi-ai` 和 `fi-web-search-preferences` 已使用的回退方式相同。两个值均为必需；缺失任意一个都会在发出任何网络请求之前抛出异常，并指出这两个引用名及每个可设置的位置（环境变量、fi home 目录或启动目录中的 `.env` 文件，或网页版模型页面写入的已存储凭据）。
- 引用的*名称*而非其值，是 `FiAntigravityConfig` 的字段：`oauthClientIdRef`/`oauthClientSecretRef`，均为 `Volatile<string>`，默认值分别为 `ANTIGRAVITY_OAUTH_CLIENT_ID`/`ANTIGRAVITY_OAUTH_CLIENT_SECRET`。实时编辑无需重启即可影响下一次登录尝试或刷新：`registerAntigravityFlow` 的流程闭包在每次 `run()` 时读取一个返回引用的 thunk,而不是在注册时捕获的快照。
- `resolveAntigravityGrant(ctx, signal?, refs?)` 保持 `signal` 位于其既有的第二个位置——`tool-image-generation` 与 `web-search-subscription` 已经这样调用——并在进入凭据存储的串行化 `modifyRecord` 之前解析 OAuth 客户端，因此无论哪个竞争者赢得并发刷新,该显式失败路径每次刷新只运行一次。
- `scripts/fi-provider-settings-lib.mjs` 的 `validateProviderSettings` 会将 `antigravityCli.oauth.clientId` 从其校验的每份快照中投影移除，而保留其他提供方的 `oauth.clientId`（`claudeCode`、`codexCli`）不变——那些是密钥扫描不会标记的不透明应用 id。供应商更新脚本保持字节级不变；哈希清单通过该库自身的 `providerSettingsHashManifest` 重新计算，与"刷新"更新流程已产生的自一致哈希方式相同（源设置哈希与快照哈希相等，因为两者都是同一个刚序列化的值）。
- 打包后的桌面端：`apps/desktop/electron-builder.config.mjs` 仅在打包环境设置了 `ANTIGRAVITY_OAUTH_CLIENT_ID`/`ANTIGRAVITY_OAUTH_CLIENT_SECRET` 时,才把它们嵌入打包清单的 `extraMetadata`；`apps/desktop/src/main.ts` 会读回这两个值，并仅在用户自身环境尚未定义该变量时,用它们为 Host 进程环境补种。未签名/开发构建，或未设置这两个环境变量构建出的发行版，都不会打包任一值，其行为与源码 CLI 完全一致。

## 已考虑的替代方案

**保留字面量但轮换它。** 轮换后的客户端 id 仍是仓库字面量，GitHub 会在下一次提交时再次标记它；轮换在结构上毫无收益。

**只分发客户端 id，不分发密钥。** 该客户端的 Google 已安装应用 OAuth 令牌交换需要密钥；拆分二者仍会让 id——匹配同一密钥扫描模式——继续留在提交历史中。

**只从 `process.env` 解析，跳过凭据接缝。** fi 的其他每一个提供方凭据（`llm-pi-ai`、`fi-web-search-preferences`）都优先通过 `ctx.credentials` 解析，只有在未挂载凭据服务时才回退到启动环境；让 Antigravity 的 OAuth 客户端走不同的解析方式，会使其无法使用网页版模型页面已经为其他每个提供方写入的已存储凭据界面。

**在 `fi-provider-settings-lib.mjs` 中对所有提供方一律拒绝 `clientId`。** `claudeCode` 与 `codexCli` 也携带一个密钥扫描不会标记、且本快照合理捕获的 `oauth.clientId`；一概拒绝会在没有任何安全收益的情况下破坏这些提供方的元数据捕获。

## 测试

| 证据 | 行为 |
|---|---|
| [flow.host.spec.ts](../../../../packages/fi/llm-antigravity/tests/flow.host.spec.ts) | 当两个 OAuth 客户端引用均未配置时，登录流程会在发出任何网络请求之前显式失败，并指出这两个引用名。 |
| [plugin.host.spec.ts](../../../../packages/fi/llm-antigravity/tests/plugin.host.spec.ts) | 令牌刷新通过预先设置的伪造凭据解析 OAuth 客户端；当两个引用均未配置时，会在任何 `fetch` 调用之前显式失败并指出这两个引用名。 |
| [fi-provider-settings.spec.ts](../../../../scripts/fi-provider-settings.spec.ts) | `validateProviderSettings` 会剥离 `antigravityCli.oauth.clientId`，同时保留 `codexCli.oauth.clientId`，且剥离后的快照可原样往返。 |

## 后果

- Google OAuth 客户端 id 与密钥今后不会再出现在本仓库或其历史记录的任何位置；部署方需通过其运营者已用于其他凭据的三种渠道之一，一次性提供这两个值。
- 未配置的源码检出或打包后桌面端构建仍能提供静态 Antigravity 模型目录，但在设置这两个值之前无法登录或刷新；这是预期的显式失败行为，而非回归。
- 未设置这两个打包期环境变量构建出的桌面端发行版，其 Antigravity 登录同 CLI 一样处于未配置状态；希望在特定发行版中预先配置它的维护者需要在该次打包运行中设置这两个变量。
- `resolveAntigravityGrant` 的另外两个调用方（`tool-image-generation`、`web-search-subscription`）始终解析默认引用名；如果部署方通过 `FiAntigravityConfig` 更改了任一引用名，且同时使用这两项功能对 Antigravity 授权的复用，则仍需保证默认引用名可解析。
