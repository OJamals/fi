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

## Phase 5 2026-09-11：Antigravity —— 第二个适配器家族

第一个非 pi-ai 适配器证明了 seam 设计的成立。`@fi/llm-antigravity` 在 pi-ai 使用的同一个 `ctx.authorization` seam 上注册了 Antigravity OAuth 流程（`fi-antigravity/antigravity`）， 其传输通过付费的 Cloud Code 端点提供 Gemini/Claude 模型。Host 控制器的 `ROUTE_NAMESPACE_BY_SCOPE` 增加一行（`fi-antigravity` → `llm-pi-ai`），因此 Antigravity 授权将 `providers.antigravity` upsert 到模型页面管理的同一个 settings 命名空间——路由 出现在 pi-ai 路由旁边，而页面无需感知差异。

OAuth 流程是 Google PKCE，使用 Antigravity 桌面应用的公共客户端 id，回环重定向 `127.0.0.1:54545/callback`（不是 `localhost:3000`——浏览器 service worker 会劫持该源）， 以及五个 scope（含 `cloud-platform` 与 `cclog`）。交换后通过 `loadCodeAssist` 发现 `cloudaicompanionProject`，它成为每个推理请求所命名的计费项目。传输将 Gemini `contents`/`generationConfig` 包装进 Cloud Code envelope （`{project, model, request, userAgent: "antigravity", requestId, requestType: "agent"}`）， 并 POST 到 `v1internal:streamGenerateContent?alt=sse`。

模型页面卡片是 `@fi/client-ui-model-signin-antigravity`，与 pi-ai 卡片平行的包，注册进 相同的两个槽位。当流程已注册且无存储授权时，页脚提供“Sign in with Antigravity (Gemini Code Assist)”；行卡片出现在 id 为 `antigravity` 的提供方卡片内。

Stealth 刻意保持最小：UA 字符串与发现请求中的 `ideType: "ANTIGRAVITY"` 是仅有的身份声明， 均为捕获派生。没有计费头指纹（Anthropic）、没有 originator 头（Codex）、没有 plan=generic（Grok）——Antigravity 的 OAuth 是标准的 Google 安装应用流程，其传输的 envelope 是官方认可的形状。

## 密钥徽标 2026-09-11 — 已调研并明确不实现

早期一轮针对 OAuth 徽标问题的尝试在模型页面派生的 `<ROUTE>_API_KEY` 引用处停放标记值（`oauth-grant:<key>`），使已登录提供方的行不再显示缺少密钥。在将上游点状逻辑读到底之后，该实现于提交前被回滚：可见的行圆点要求**命名了** `apiKeyEnv`（仅对命名引用判定 `credential?.configured === true`），而路由未命名 `apiKeyEnv` 时**完全不显示**密钥圆点——绝不会显示误导性的“缺失”（`credentialMissing` 额外要求 `apiKeyEnv !== undefined`）。因此该标记只会喂给槽位座位的 `keyConfigured` 属性，而登录卡片根本没有读取该属性；同时带来真实隐患：此后若用户或编辑器在路由上写入 `apiKeyEnv: <DERIVED_REF>`，标记会被解析为 Bearer token，使请求时的授权被垃圾串替换。

正确的终点就是上游已经实现的那个：OAuth 行不显示任何 API-key 状态，行内的登录卡片承载事实（“Signed in / Not signed in / Remove sign-in”）。OAuth 确实不使用典型的 API key 或 base URL，页面现在对它们保持沉默而非错误。


## Phase 4 2026-09-11：SuperGrok/X Premium 以一行加入

xAI 的设备码 OAuth（“Sign in with SuperGrok or X Premium”）随同一个已安装的 pi-ai 目录发布（`auth/oauth/xai.js`），而 `registerPiAiFlows` 早已像另外两个提供方一样注册了 `llm-pi-ai/xai`。因此必要的改动恰好是卡片从第一天起就文档化的扩展点：客户端 store 中 `OFFERED` 增加一行。路由语义无需改动——Host 的 scope→命名空间规则以同样方式覆盖 `llm-pi-ai/xai`，且 `adopt('llm-pi-ai/xai')` 通过同一条 `llm.discoverModels` 路径 upsert `providers.xai` 并枚举 Grok 模型。集成测试现在针对已安装的 pi-ai 构建断言全部三个目录流程，因此 pi-ai 若重命名或移除 xAI 登录，套件会失败，而不是悄悄缩减页脚。

## 页脚：为尚无路由的提供方添加

行卡片需要有一张提供方卡片可扩展，而在全新安装中根本不存在任何 pi-ai 路由。模型区块为这一场景保留了第二个槽位 `settings.models.footer`，因此第二个注册把同一个 store 与对话放到了提供方行之下：一条“使用您的订阅登录”区域，以相同的 OAuth 按钮列出 Claude Pro/Max 与 ChatGPT Plus/Pro，通过同一个 `AttemptView` 运行相同的对话，随后链接 Host 的 `adopt(key)`——在 settings 路由缺失时 upsert 该路由，并枚举该路由接着提供的模型。store 中的 `signInAndAdopt(key)` 将 `begin('oauth')` 与采用折叠为一次意图，以尝试自身的 `authorized` 结束为门槛；同一行上的 `revoke` 重新打开该按钮。已存储授权的提供方显示为已订阅而非可采用，因此列表只对真正新的提供方重新出现该按钮，而横幅保留最后一次采用的证据。模型区块自身的 `settings/document-updated` 刷新无需额外接线即可将该新行带入，这正是成功采用为何无需其他 UI 的原因：用户请求的路由落在承载提供方卡片的同一个区块里。

随页脚到来的两个 Host 调用——`listAdoptable()` 与 `adopt(key)`——是该 seam 两个半部的读取侧（哪些凭据 scope 携带 settings 路由，以及已登录者接下来还需要什么）。`adopt` 读取已存储的授权而非重跑 OAuth，因此表层无需第二次交互；只提交凭据而从不 `revoke` 的流程采用是幂等的，这正是为什么当模型区块自身的 `document-updated` 刷新重渲染该行时，相同的路由写入可以干净地重复。

## 阶段 6 2026-09-11：统一为单一区块，并补上 record-updated 缺口

实际使用暴露了三个缺陷，由同一次重构一并修复。

**Antigravity adopt 崩溃。** 独立的 Antigravity 卡片 store 调用 `remote.authorization.adopt(key)` 后直接对结果取 `adopted.models.join(...)`。每个一元 Remote 动词返回的都是 `{ok, value}` 信封而非裸值——这与早先 `list()` 修复所钉住的教训相同，现在推广为：每个一元调用都必须解包或检查 `.ok`；只有流式动词（`begin`）例外。TypeError 抛出时授权其实已经提交，因此用户在一次成功的登录之下看到了“登录失败”。独立卡片包（`@fi/client-ui-model-signin-antigravity`）已删除；统一区块让 Antigravity 走与 pi-ai 提供方相同的 store 路径，那里始终正确解包信封。

**重新登录按钮不重现。** 删除授权发出的是 `credentials/record-updated`（授权是记录），而区块只监听 `credentials/reference-updated`（API 密钥引用）——因此任何表层上的撤销都会让区块继续渲染过期的已存储标记，登录按钮永远不会重现。`packages/api/remotes/src/remote-events.ts` 中的 `API_REMOTE_FORWARDED_EVENTS` 增加一行带标记的增量（`{ event: 'credentials/record-updated', mode: 'emit' }`）——这是 fi 对上游运行时文件的第一处增量，其正当性在于：该允许列表是 Host 事件到达浏览器的唯一合法途径，而替代方案（轮询）显然更差。store 的 `remove()` 也在 `finally` 中重新加载，因此撤销被拒绝或失败同样不会让表层停留在过期状态。

**底部两个区块、且凭据 UI 夹在模型行之间。** `selectOfferedRows` 中的白名单连接在结构上排除了 `fi-antigravity/antigravity`，迫使 Antigravity 独占一个页脚区块；而逐行登录卡片（`settings.models.provider-card`）把凭据 UI 夹进了模型行之间，观感杂乱。现在该区块是唯一的登录界面：`OFFERED` 增加 Antigravity 键（provider id 从键通用派生，而非按 pi-ai scope 截取），页脚行在 stored 标记的两个方向上都渲染——未登录提供“添加”，已登录显示状态并提供“重新登录”与“移除登录”——`provider-card` 注册已移除。模型列表中的提供方行恢复为纯路由行；路由本身保留，因为 settings 路由是提供方可供服务的前提，由页面自行管理。

用户看到的夹在模型行之间的 Anthropic/Codex/Antigravity 已登录行是 adopt 创建的路由而非凭据——这部分是设计使然（路由存在才能提供模型），而区块现在镜像它们的登录状态，使管理集中于一处。

## 阶段 7 2026-09-11：原生 Antigravity 适配器与过期横幅缺陷

实际使用发现了迄今最尖锐的缺陷：Antigravity 登录成功，但区块仍显示早前 xAI 采用的模型列表。三个叠加的原因，对应三处修复。

**路由永远无法服务。** adopt 路径把 `fi-antigravity` 凭据 scope 映射到 `llm-pi-ai` 设置命名空间，但 pi-ai 目录中没有 `antigravity` 提供方——设置写入被 pi-ai 自己的 section 校验拒绝（已核实：线上设置文件没有残留条目），`ensureRoute` 回答 `skipped`，`adopt` 抛出 `adopt-blocked`。修复是 fi 原生适配器：`@fi/llm-antigravity` 现在拥有 `fi-antigravity` 设置命名空间（每条路由一份 profile，空挂载休眠，沿用 pi-ai 插件的姿态），挂载一个 `LlmAdapter`，通过已移植的 Cloud Code 传输为这些路由服务，声明模型页面"添加提供方"目录读取的目录项，并为其命名空间应答模型发现——授权可达实时目录时用实时投影目录，否则用静态列表。controller 的 scope→命名空间映射新增 `fi-antigravity → fi-antigravity`，因此 `adopt` 写入的路由真正能服务、能枚举。

**横幅从不清除。** store 的 `adopt()` 失败路径设置了 `error` 但保留了 `adopted`——而区块根本没有渲染 `state.error`，于是上一个提供方的模型列表留在屏幕上，被读作新登录的结果。现在：开始任何尝试都会清除横幅；失败的 adopt 再次清除并设置错误；区块把错误渲染为指明 Host 诊断的内联告警。一个细节耗费了一轮测试：`drive()` 的 finally 原先在 `load()` 之前运行 settle 钩子（adopt），而 `load()` 成功时会清除 `error`——顺序改为先 load 后 settle，横幅与错误成为最后一次写入。

**已完成的尝试会锁死界面。** `drive()` 在快照被任何尝试占用时拒绝启动——包括已完成的尝试——于是完成一次登录后，其他提供方的按钮在用户关闭卡片前全部静默失效。现在，已完成的尝试会被下一个动作取代（正如其关闭按钮所做的）；只有正在运行的尝试才锁定界面。

**授权 payload 需要结构化收窄，而非形状教条。** 线上存储中的 Antigravity 记录实际携带 `{access, refresh, expires, projectId}`——没有 `type: 'oauth'` 标记，项目键也与流程写入的不同。解析器最初的收窄要求该标记且只读 `antigravityProjectId`/`accountUuid`，于是每次解析都失败：发现只返回静态目录，流以 `no-grant` 结束——而授权其实存在且有效。现在检查是结构化的：记录键已限定在本插件的流程，访问令牌字符串即是授权，项目 id 从三个历史键中任择其一读取。随后基于真实存储（副本）完成了全链路实网验证：过期令牌经 Google 刷新，`fetchAvailableModels` 以账户自身的排序返回实时投影目录，真实流式请求返回了文本与 stop 结束。回归测试钉住了这种前 profile 形态。

**提供方编辑器无法创建仅授权的路由。** `ProviderEditor` 的 `layoutOf` 只认识 `llm-deepseek` 与 `llm-pi-ai` 命名空间；其他命名空间得到 `unknown` 布局，渲染"字段在 settings.yaml 中"的提示并硬性禁用 Apply。因此 Antigravity 的目录项虽出现在"添加提供方"中却无法在那里应用——一个绝不能被误认为路径的死胡同。目录项保留，因为提供方行是目录与存活路由的连接（移除它会隐藏已采用的路由）；区块的登录 → adopt 链路才是预期路径，而感知授权的编辑器布局应留给上游设计。

适配器对能力刻意诚实：它不从附件服务解析 `ImageBlock`/`FileBlock` 字节，因此其模型声明 `inputModalities: ['text']`，界面会拒绝附件而不是静默丢弃。令牌刷新通过凭据接缝的串行化 `modifyRecord` 并在锁内复查，并发调用不会丢失彼此的轮换。

## Consequences

只要 composition 在 `@deepseek-ai/dsh-base` 之后列出 `@fi/authorization-bundle`，该 seam 即被挂载，`dsh-llm-pi-ai` 随即注册其登录流程，无需其他配置。pi-ai 仍是其自身凭据记录的唯一写入方——流程通过它自己的 store 适配器提交，由 seam 确认写入，因此刷新仍在该 store 的跨进程锁下工作，且已存储的授权在任何 `apiKeyEnv` 覆盖之下为其路由提供认证。没有任何密钥经由新命名空间双向传输。

所提供的提供方列表是针对已安装的 pi-ai 目录断言的，而非针对固定装置，因此 pi-ai 升级若重命名某个提供方或移除其 OAuth，会让集成测试失败，而不是悄悄清空该卡片。向卡片添加提供方只需修改 `OFFERED` 一行，而 Host 未注册的流程根本不会出现。

两个上游文件各增加一条引用——`tsconfig.host.json` 与 `tsconfig.client.json`——因为它们的项目列表是显式的。Typert 生成器通过工作区扫描发现新包，因此 `authorization` 命名空间及其客户端类型无需改动 `packages/api/remotes` 即可生成。
