# Agent Note: 为 Exa 与 Perplexity 搜索提供方引入凭据引用解析

Status: implemented

[English](2026-09-25-web-search-exa-perplexity-credential-reference.md) | 中文

## 问题

`dsh-web-search-exa` 与 `dsh-web-search-perplexity` 都只在插件注册时捕获一次 API 密钥：`apply()` 读取 `config.apiKey ?? launchEnvironmentOf(ctx).get('EXA_API_KEY')?.value ?? ''`（Perplexity 对应 `PERPLEXITY_API_KEY`），写入交给提供方构造函数的固定 options 对象。此后通过 `ctx.credentials` 存储或轮换的密钥，在插件重新加载之前不会生效；而注册时没有密钥的部署，从 `ctx.web` 注册表得到的只是笼统的 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，而非指出缺失哪个凭据引用的诊断。`dsh-web-search-deepseek` 早已为自己解决了这两个问题——基于 thunk 提供 options 对象的 `resolveApiKey`／`apiKeyEnv`，每次搜索都重新解析，并以 `WEB_PROVIDER_CREDENTIAL_MISSING` 指出引用名与存储方式——但另外两个提供方从未获得同样的处理，这种不对称已没有继续存在的理由。

与此独立的是，本仓库实际发行的路由层 `@fi/web-search-preferences`（`packages/fi/authorization-bundle/cordis.patch.yml`）已经在自身内部为每次操作重新解析凭据，并为每次搜索重新构造提供方实例。因此，缺口存在于这两个包自身的独立 `apply()`／`Config`（一个部署可直接挂载的公开面，参见各包的 `peerDependencies`），而不存在于 fi 实际发行的 web 搜索路径中。

## 决策

`ExaSearchProvider` 与 `PerplexitySearchProvider` 改为接收 `resolveOptions: () => Options` thunk，而非固定的 options 对象，与 `DeepSeekSearchProvider` 的构造函数完全一致。`available()` 与 `search()` 每次操作都调用一次该 thunk；`search()` 还通过新增的私有 `apiKey()` 方法解析密钥：非空的 `options.apiKey` 直接胜出，否则在调用方 `AbortSignal` 下等待 `options.resolveApiKey()`（复用 `DeepSeekSearchProvider` 已有的 `abortable`／`throwIfSearchAborted`／`searchAborted` 辅助函数），密钥无法解析时以 `WEB_PROVIDER_CREDENTIAL_MISSING` 抛出，指明 `options.apiKeyEnv` 及存储方式。两个包的 `Config` 都新增了 `apiKeyEnv`（一个标注 `credential-ref` 角色、默认值为各自环境变量名的字符串字段），与既有的 `apiKey` 并存；`apply()` 构建一个 `resolveOptions(ctx, config)` 闭包，在 `ctx.get('credentials')` 已挂载时通过它解析凭据，否则回退到 `launchEnvironmentOf(ctx)`——与 DeepSeek 的 `resolveOptions` 已有的回退逻辑逐字节一致。

两个包的 `Config` 字段都保持普通（非 `Volatile`），而非采用 DeepSeek 的响应式设置形态：目前没有任何界面读取实时的 Exa／Perplexity 设置区块（`ui-settings-web-search` 硬编码为 `web-search-deepseek` 命名空间），为这两个提供方引入 `Volatile` 字段与设置卡片只会是无人使用的机制。凭据轮换行为仍由 thunk 单独提供：无论外层 `Config` 是否响应式，`resolveApiKey` 都会在每次调用时重新执行一次 `ctx.credentials.resolve()`。

`@fi/web-search-preferences` 本身已经解析凭据并为每次操作重建提供方，因此它的两处调用点只需把已解析的 options 包进 `() => options`——该构造函数的 thunk 在那里最多只会被调用一次，行为不变。

`resolveApiKey` 闭包（index.ts）、`apiKey()` 方法，以及 `if (!response.ok)` 的 HTTP 错误解析代码块，现在在三个 web-search-* 提供方包之间近乎逐字重复。`web-search-exa`／`web-search-perplexity` 中的每处都用一对裸露的 `/* jscpd:ignore-start */…/* jscpd:ignore-end */` 包裹（必须是 `jscpd.json` 的 `ignorePattern` 精确匹配的字符串——说明性文字要放在相邻的普通注释里，而非标记注释内部，否则该模式会静默失配）。`web-search-deepseek` 未添加标记：只要排除 exa／perplexity 两处出现，语料中就不再剩下可报告的重复配对。

## 权衡的替代方案

- **让 Exa／Perplexity 的独立 `apply()` 改为通过 `@fi/web-search-preferences` 的 `resolveCredential()`，而非复刻 DeepSeek 的模式。** 已否决：该路由是位于这两个已发布的 `@deepseek-ai/dsh-web-search-*` 包之上一层的 `@fi/*` 包；让这两个提供方依赖它会颠倒依赖方向，把一个面向上游的包耦合到一个 fi 专属的消费方。
- **为 Exa／Perplexity 引入 DeepSeek 那套完整的 `Volatile` 配置面。** 目前已否决：没有任何设置界面读取实时的 Exa／Perplexity 区块，响应式机制不会产生任何可观察效果，只会新增无人使用的配置 schema 机制。若 `ui-settings-web-search`（或其后继者）将来推广到 `web-search-deepseek` 命名空间之外，可重新评估。
- **维持独立包现状，理由是 fi 发行的路由层已在生产中覆盖了凭据轮换问题。** 已否决：这两个包是已发布的包（`publishConfig.access: public`），可独立于该路由被引入；直接挂载 `web-search-exa`／`web-search-perplexity` 的部署或下游项目，仍会撞上 `web-search-deepseek` 早已为自己修复的同一个缺陷。

## 后果

`ExaSearchProvider`／`PerplexitySearchProvider` 的构造函数变更对任何以普通 options 对象直接实例化的代码都是破坏性变更；本仓库中的两处调用点（`@fi/web-search-preferences`，以及各包自身的测试与 `*.e2e.ts` 冒烟测试）已在同一变更中更新。两个包都新增了 `@deepseek-ai/dsh-credentials` peer／dev 依赖，Exa／Perplexity 的 devDependencies 还为轮换测试新增了 `@deepseek-ai/dsh-credentials-local`。两个测试套件中的“配置与环境都未提供密钥时不可用”（`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，在 `search()` 运行之前由 `ctx.web` 注册表检查）已经消失：只要 `resolveApiKey` thunk 存在（`apply()` 运行后始终存在），`available()` 现在都返回 `true`，诊断因而移入 `search()` 本身，表现为 `WEB_PROVIDER_CREDENTIAL_MISSING`——与 `web-search-deepseek` 一致的、更具体的错误。延后事项：一张跨所有 `ctx.web` 提供方通用的设置卡片（目前 `ui-settings-web-search` 只认 `web-search-deepseek`），以及把现已出现三份的 `resolveApiKey`／`apiKey()`／HTTP 错误解析形态抽取为共享辅助函数——在出现第四个提供方或真正的行为分歧迫使抽取之前，刻意保留为带 jscpd 标记的重复代码。
