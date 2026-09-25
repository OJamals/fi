# Agent Note：pi-ai 路由的实时订阅模型发现

Status: implemented

[English](2026-09-25-live-subscription-model-discovery.md) | 中文

## 问题

fi 的 Claude Code、Codex 与 Grok 路由只列出 pi-ai 为 `anthropic`、`openai-codex`、`xai` 提供的已安装目录；已登录账户的新发布在 vendored 目录跟上之前始终不可见，这与 fork 自身的原生 Antigravity 适配器不同——后者早已在其静态回退之外列出实时模型。

## 决定

[`@deepseek-ai/dsh-llm-pi-ai`](../../../../packages/llm/llm-pi-ai/README.zh.md) 新增了一个通用、与提供方无关的扩展点：`llm-pi-ai/live-models` waterfall。适配器只在以下情况调用它：路由没有自己筛选的 `models` 列表，且其已存凭据经 pi-ai 自身的 `Models.getAuth` 解析为 `OAuth`，并且该提供方在 pi-ai 已安装目录中被标记为 `auth.oauth.isSubscription`。一个已安装目录中不存在的实时 id，会以其最相近目录模板的克隆形式提供——即与该 id 共享最长前缀的模型，若无任何模型共享前缀则取路由的第一个模型——因此它会经由与其同系列相同的 api、baseUrl 与兼容特性进行流式传输；只有 id 与名称会变化。`listModels`、`resolveModel`、点名某个仅存在于实时列表中 id 的请求，以及本包自身的 `discoverModels`（供采纳流程与「获取可用模型」使用），都经由这同一条路径解析。

[`@fi/provider-compat`](../../../../packages/fi/provider-compat/README.zh.md) 是唯一的监听者。它抓取 Claude Code 的 `/v1/models`、Codex 的 `/codex/models`（复用 `If-None-Match` ETag）以及 Grok 的 `/models`，每一个都使用 `subscriptionHeaders` 已经为聊天请求构建好的同一身份，并按部署方配置的 TTL（`liveModelDiscoveryCacheTtlMs`，默认五分钟）在失败时优先沿用旧值的策略下缓存每个提供方的列表；`liveModelDiscoveryEnabled` 可整体关闭该机制。`llm-pi-ai` 内部不点名任何 fi 提供方 id。

刚登录后的重新列出复用了既有的 `llm/adapters-updated` 通知，而不是新增第二套机制：一条全新路由已经会经由常规的路由集合变化路径重新触发它；而 `registerPiAiFlows` 新增的 `onSignedIn` 回调，则为一条已在较弱或缺失授权下存在的路由强制发出同一通知——因为这种情形不会改变既有路径所跟踪的任何注册事实。

## 已考虑的替代方案

**把实时 id 直接写进 pi-ai 的 `Provider.getModels()` 返回值**——已拒绝：该函数在 profile 解析构建集合时被同步读取，而实时发现本质上是一次异步、带缓存的网络调用。改在适配器层（`listModels`/`resolveModel`/`stream`）合并，既保持了集合同步契约不变，又能让合并结果始终反映最新缓存的列表。

**让 fi 的监听者自行构造完整的 pi-ai `Model` 描述符**——已拒绝：克隆一个模板模型需要目录相关知识（兼容块、推理映射、baseUrl），而这些逻辑已经存在于 `llm-pi-ai/catalog.ts` 中。让 `@fi/provider-compat` 重新实现这套逻辑只会造成重复，并有偏离风险。该 waterfall 只携带 id 与可选名称；克隆工作由 `llm-pi-ai` 完成。

**新增一个专门的重新通知事件**——已拒绝：`AdapterRegistrationHandle.replace()` 已经存在，且每次调用都会无条件触发 `llm/adapters-updated`。复用它重放同一份路由集合只是一行代码，而不必让 Web 模型选择器再学习一套新机制。

**只把提供方字符串交给实时模型监听者，再由其另行读取凭据来解析令牌**——已拒绝：实时列表查询是监听者自行发起的旁路调用，不同于 `llm-pi-ai/request-transport` 对 pi-ai 自身 SDK 已认证请求的请求头/fetch 变换。监听者必须拿到已解析的令牌才能发起这次调用，因此适配器在自己完成那一次 `Models.getAuth` 核实后直接把令牌交给它；监听者本身从不读取原始凭据。

## 后果

订阅账户能在 pi-ai 已安装目录尚未跟上时立即获得新模型，且不需要发布新包。环境或 API 密钥鉴权的路由，以及经过筛选的 `models` 列表，都不会被触及——决定一条路由能否被扩充的那道限制完全在 `llm-pi-ai` 内部，监听者从不做这个判断。一次实时列表故障只会退化为已安装目录：由于每条失败路径都会归结为空的实时列表而不会向外传播，它不可能破坏 `listModels`、`resolveModel`、请求或发现。

`@fi/provider-compat` 的缓存按提供方、按插件实例保存，而非按账户保存：若某部署让多个账户共用同一提供方路由，看到的会是最近一次刷新的那个账户的列表，直到下一个 TTL 边界。此处不进行任何后台轮询；只有当 `listModels`、发现或某次请求在 TTL 到期后真正触达该路径时，缓存才会刷新。

## 所需验证

使用本地模拟 HTTP 服务器的单元测试覆盖了每个提供方的请求 URL 与请求头（不使用真实令牌）、响应解析、Anthropic 的 `claude-*` 前缀过滤与 Codex 的 `visibility: "hide"` 过滤、Codex 的 ETag 304 路径、TTL 到期与刷新，以及失败回退到已安装目录——见 [`packages/fi/provider-compat/tests/provider-compat.host.spec.ts`](../../../../packages/fi/provider-compat/tests/provider-compat.host.spec.ts)。适配器层测试覆盖了 OAuth/完整目录闸门、经过筛选的 `models` 列表保持不变、仅存在于实时列表中的 id 能够解析并经其克隆模板完成流式传输，以及 `listModels` 能反映监听者钩子后续的变化——见 [`packages/llm/llm-pi-ai/tests/live-models.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/live-models.spec.ts) 与 [`clone-live-model.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/clone-live-model.spec.ts)。发现结果合并行为见 [`discovery.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/discovery.spec.ts)，登录后重新通知的回调见 [`login.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/login.spec.ts)。
