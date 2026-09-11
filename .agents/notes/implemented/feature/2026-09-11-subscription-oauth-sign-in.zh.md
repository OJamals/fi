# Agent Note：模型设置中的订阅 OAuth 登录

Status: implemented

[English](2026-09-11-subscription-oauth-sign-in.md) | 中文

## Problem

模型页面此前只能收集 API 密钥。持有 Claude Pro/Max 或 ChatGPT Plus/Pro 订阅的用户无法使用其已付费的推理能力，因为这些提供方通过 OAuth 授权而非输入密钥进行认证。实现所需的部件其实已在代码库中，只是处于未激活状态：已安装的 pi-ai 目录为 `anthropic`（“Anthropic (Claude Pro/Max)”）和 `openai-codex`（“OpenAI (ChatGPT Plus/Pro)”）提供了 OAuth 登录，而 `dsh-llm-pi-ai` 的 `registerPiAiFlows` 已为每个此类提供方注册了一个授权流程。但没有任何一方消费它们：没有 bundle 挂载 `@deepseek-ai/dsh-authorization`，因此 `ctx.authorization` 不存在，每次 `registerFlow` 调用都找不到该 seam；没有 Remote 命名空间把该 seam 暴露给浏览器；模型页面也没有登录入口。

## Decision

三个 fi 自有包，每个都落在已存在的 seam 上，不修改任何上游包。

`@fi/authorization-bundle` 是一个 patch 层，其全部内容是挂载 `@deepseek-ai/dsh-authorization` 的一行。它独立成为一个 bundle，而不是写进 `packages/bundle/base/cordis.patch.yml` 的一行，这样上游的 base patch 能保持逐字节一致。顺序无需人工编排：`AuthorizationService` 声明了 `static inject = ['credentials']`，因此 Cordis 会让它挂起，直到 base 层的 `credentials` 行就绪。该行本身是惰性的——不注册任何流程，也不获取任何凭据——这正是它可以安全加入任何 profile 的原因。

`@fi/api-authorization-controller` 拥有 `authorization` Remote 命名空间，提供 `list`、`begin`、`answer` 和 `cancel`。`begin` 是一个 `@Remote({ mode: 'stream' })` 方法：一次授权尝试是一场对话，流程的通知、提问与最终结果都走调用方开启的同一条载体。采用流式而非转发 Host 事件，保留了该 seam 自身的性质——提示恰好抵达发起提问的那个界面，其 `AuthorizationInteraction` 正是为此按请求提供——同时让上游白名单 `API_REMOTE_FORWARDED_EVENTS` 保持不变。该流始终以恰好一个 `settled` 帧结束，失败也不例外，因此界面无需从载体关闭去推断终态。空答复被读作用户拒绝，这正是该 seam 在拒绝（`cancelled`）与故障之间所作的区分。

`@fi/client-ui-model-signin` 注册到 `settings.models.provider-card`，即模型区块已经声明的扩展槽位，其用途正是“让仓库之外分发的插件在不修改模型设置区块的前提下向其添加 UI”。该区块以行的 `settingsNs` 作为键分发该槽位，对每个 pi-ai 路由而言即 `llm-pi-ai`，因此该卡片能看到这些行，并只为已注册 OAuth 流程的那些行渲染。它只提供 `oauth` 方式：模型页面已经以普通字段收集 API 密钥，为同一件事开第二道门只会让页面更糟。

## Alternatives considered

**用本地 HTTP 代理转换为 OpenAI 兼容端点。** 公开的 Antigravity 与 Codex 代理都这么做，但那只是因为它们的客户端只能通过 base URL 寻址模型。本仓库有适配器 seam，因此代理只会带来一个承载用户订阅配额的无鉴权开放端口，以及一个需要照管的额外进程，而不会带来适配器路径所缺少的任何能力。

**通过 `API_REMOTE_FORWARDED_EVENTS` 转发 `authorization/settled`。** 该事件确实存在并能报告结果，但它无法承载对话中提问的那一半，而且该白名单是一个上游数组——修改它正是本次改动刻意避免的那类 delta。流式方案同时承载两半，且无需白名单条目。

**在 `CredentialsController` 上扩展授权方法。** 它是上游包，而且两个 seam 职责不同：credentials 存储密钥，authorization 获取密钥。独立的 controller 让 fi 的 delta 保持增量，也让命名空间语义清晰。

**展示所有已注册的流程。** pi-ai 目录注册了约四十个，其中绝大多数只支持 API 密钥。全部列出会把两个订阅登录淹没在模型页面本就以密钥字段处理得更好的行里。

一次成功的尝试还会留下该提供方的 settings 路由：当 scope 带有路由规则（`llm-pi-ai/<id>` → `llm-pi-ai` 命名空间）时，controller 会通过带 `expectedRevision` 的 `settings.mutate` 写入与模型页面自身“添加提供方”流程相同的空配置，使并发的路由写入胜出而不是被覆盖。settled 帧对结果分类（`created`、`already`、`skipped`），且 skipped 的路由绝不会降低登录结果——授权先行提交，路由写入只是叠加在该事实之上的便利。`remove(key)` 是与之相配的重置：删除记录，在尝试运行期间拒绝，并刻意保留路由，因为路由是模型页面负责删除的用户配置。另一个适配器族通过在 scope 到命名空间的映射中加入一行来接入。

本次工作固化了两条规则，今后添加 Remote 方法时值得临时保持：

- **方法名与命名空间服务是线上保留关系。** 客户端 `RemoteNamespaceService`（packages/api/gateway/src/client/index.ts）拥有名为 `remove` 的实例方法（用于卸载方法）。Remote 客户端会拒绝任何与命名空间服务自身 API 冲突的命名空间方法（`assertMethodAvailable`），对任何命名空间都如此。这是线上保留名规则，不是构建过期问题——重新构建永远无法解决它。原动词为 `remove`，线上动词改为 `revoke`（`authorization.revoke(key)`）。客户端 store 保留其公开名 `remove(key)` 作为 UI 动作，但线上调用为 `remote.authorization.revoke(key)`。
- **浏览器插件必须自行 `$mount` 其 Remote contribution。** 应用级 api-remotes 客户端目录只挂载其精选的命名空间列表；没有任何组件为浏览器插件安装 `remote.authorization`。遵循 `client-ui-agent-team` 模式——在 `apply()` 中先 `ctx.remote.$mount(fiAuthorizationRemote)`，返回其 disposer，然后注册槽位。`inject` 仅列出 `['slots', 'locale', 'remote']`。
- **挂载命名空间并不等于获得访问权。** Cordis 会拒绝从未声明它的 fiber 读取 `ctx.remote.authorization`（报 `cannot get property "remote.authorization" without inject`，在客户端启动时以 pageerror 出现，导致插件未挂载、其 UI 缺席）。完整模式是两步：在 `apply()` 中先 `$mount` contribution，再 `ctx.inject(['slots', 'locale', 'remote.authorization'], (scoped) => ...)`，并把全部实际工作放进该作用域 fiber 中（agent-team 的 `mountAgentTeamUi` 形态）。静态 `inject` 条目无法做到——fiber 会在 `apply()` 挂上命名空间之前就一直等待。
- **注册进子槽位必须等待声明。** children 表中的槽位只在声明它的条目（模型区块）挂载期间存在；兄弟插件若先调用 `ctx.slots.register` 会抛 `slot ... is not declared`。用 `ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register(...))` 包裹注册——这是 packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:70 记录的书面约定，并会在所有者重挂载时重跑。

## Consequences

只要 composition 在 `@deepseek-ai/dsh-base` 之后列出 `@fi/authorization-bundle`，该 seam 即被挂载，`dsh-llm-pi-ai` 随即注册其登录流程，无需其他配置。pi-ai 仍是其自身凭据记录的唯一写入方——流程通过它自己的 store 适配器提交，由 seam 确认写入，因此刷新仍在该 store 的跨进程锁下工作，且已存储的授权在任何 `apiKeyEnv` 覆盖之下为其路由提供认证。没有任何密钥经由新命名空间双向传输。

所提供的提供方列表是针对已安装的 pi-ai 目录断言的，而非针对固定装置，因此 pi-ai 升级若重命名某个提供方或移除其 OAuth，会让集成测试失败，而不是悄悄清空该卡片。向卡片添加提供方只需修改 `OFFERED` 一行，而 Host 未注册的流程根本不会出现。

两个上游文件各增加一条引用——`tsconfig.host.json` 与 `tsconfig.client.json`——因为它们的项目列表是显式的。Typert 生成器通过工作区扫描发现新包，因此 `authorization` 命名空间及其客户端类型无需改动 `packages/api/remotes` 即可生成。
