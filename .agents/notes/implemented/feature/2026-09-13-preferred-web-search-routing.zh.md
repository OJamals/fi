# Agent Note：首选网页搜索路由

状态：已实现

[English](2026-09-13-preferred-web-search-routing.md) | 中文

## 问题

基础 profile 在 `WebRuntime` 启动时选择一个网页搜索提供方。设置写入无法替换该不可变选择。用户需要选择 DeepSeek、Exa、Perplexity、Parallel、Tavily、Serper、Brave Search 或订阅原生搜索并管理直接提供方密钥，同时不更改面向模型的工具、不复制 OAuth，也不在上游 web 包中携带 FI 补丁。

## 决策

`@fi/web-search-preferences` 注册一个稳定的 `fi-preferred-search` 提供方。FI authorization bundle 只替换基础 `web` 行的完整配置，保留 `fetchProvider: http`，并禁用单独挂载的基础 DeepSeek 提供方。FI Desktop 将该 bundle 列在上游 base 与 Web bundle 之后；公开 dsh 包不依赖 FI。FI 路由拥有现有 `web-search-deepseek` 设置命名空间，并将上游 DeepSeek `Config` schema 与 FI 字段相交，保留其默认值、字段名和字面量密钥行为。上游基础 bundle 和提供方包保持不变；移除 FI 层会使 `deepseek-official` 使用同一份已存储设置恢复。

提供方构造保留在仅 Host 的包中。`@fi/client-ui-web-search-preferences` 作为独立客户端插件负责浏览器卡片，并以优先级 `-1` 遮蔽内置 `web-search-deepseek` 卡片。可配置卡片目录读取 keyed slot 选举出的条目，因此替换后只派发一次命名空间，不会产生重复卡片。这项通用 slot 选举修正是唯一对共享上游包的更改。此拆分使提供方实现不会进入客户端 bundle，也无需为上游 Host 依赖策略添加例外。

稳定提供方在异步解析凭据或授权前取得设置区块快照。随后，它为单次操作构造所选上游 `DeepSeekSearchProvider`、`ExaSearchProvider` 或 `PerplexitySearchProvider`、FI 本地 Parallel、Tavily、Serper 或 Brave 适配器，或者 FI 订阅提供方。FI 本地适配器实现上游 `WebSearchProvider` 请求和结果类型，拒绝重定向，验证外部响应字段，并公开可配置的凭据引用和端点基础地址。设置更改影响下一次调用。进行中的调用保留原始选择和选项。所选提供方失败后，路由绝不会尝试其他提供方。

DeepSeek 请求记录继续使用 `web/deepseek-search-llm-request`。`WebSearchProvider`、`WebRuntime`、`dsh-tool-web`、fetch 选择、面向模型的 schema、Session 格式和两个 SDK 投影保留其上游行为。

## 凭据与授权

浏览器 controller 从所选提供方和当前 Host 设置解析活动凭据引用，并通过 Credentials Remote 写入直接提供方密钥。提供方变更提交前，密钥写入必须成功并回读为已配置。凭据字面量不进入设置，读取 generation 会阻止已变更或重复引用的过期响应覆盖较新的状态。凭据状态读取失败会结算为可恢复的可见错误，并继续允许只写替换。当设置文档为只读且引用可写时，仍可仅保存凭据。客户端插件卸载会停止 settings 订阅并使待定读取失效。直接适配器使用 API-key 认证，因此卡片不声称支持 Exa、Perplexity 或 Parallel MCP OAuth。

订阅搜索复用通过“模型”页面获得的 Codex、Grok、Antigravity 或 Claude 授权。搜索选择器不调用授权、不采用 LLM 路由，也不更改聊天提供方。“模型”页面继续作为唯一 OAuth 界面。

## 生命周期与失败

路由把调用方取消与一个插件生命周期信号结合。插件卸载会中止所有活动操作，包括委托清理，并且并发卸载调用会等待同一次排空。每个可配置 API-key 端点必须使用 HTTPS，FI 才会解析或发送凭据。FI 本地直接适配器会根据 DOM 异常或活动 signal 识别取消，取消失败响应的正文，并且绝不暴露外部错误正文。缺失直接提供方凭据、所选提供方不可用及订阅提供方/模型设置不完整都会显式失败。不存在会掩盖配置错误或把查询发送给未选择厂商的回退。

FI bundle 在路由生效时禁用原始 DeepSeek 提供方，因为其上游设置卡否则仍会显示，却会编辑 `WebRuntime` 不再选择的提供方。在该组合中，FI 卡片是唯一搜索偏好和密钥界面。其呈现组件使用注入的快照 hook 和操作；只有 controller 订阅设置与凭据事件。

## 后果

FI profile 分别挂载 Host 路由包与浏览器呈现包。搜索选择无需重启 `WebRuntime` 即可更改；活动调用保持稳定。直接提供方启用依赖已存储或启动环境提供的密钥，订阅选择依赖“模型”页面已有的授权。上游提供方、工具 schema、Session 事件、依赖策略和基础 bundle 文件保持不变。共享“插件”设置目录现在遵循既有 keyed-slot 遮蔽语义。

FI Desktop 打包私有 authorization-bundle 闭包并默认挂载。公开 `@deepseek-ai/dsh` 发布不依赖 FI。在另行确定公开名称、版本和发布职责前，仍无法按包名从 registry 安装。

## 考虑过的替代方案

- 拒绝在启动后修改 `WebRuntime.searchProvider`，因为上游 runtime 在构造时取得该字段快照。
- 拒绝编辑上游提供方实现或基础 bundle，因为 FI 会在后续上游更新中长期携带兼容补丁。
- 拒绝为提供方类添加 Host 依赖策略例外；拆分浏览器呈现与 Host 路由可保留现有重复安装规则。
- 拒绝以第三方搜索插件替换默认原生接口，因为已检查插件的工具名称、凭据处理、隐私行为或 profile patch 范围不同。FI 本地适配器保留一个上游工具和结果类型，同时使厂商协议可替换。
- 拒绝添加直接提供方 OAuth，因为这些适配器使用 API key 认证。Parallel 的 OAuth-capable MCP 端点仍是独立集成，订阅 OAuth 继续由“模型”负责。

## 验证

聚焦 Host 测试覆盖每个直接适配器的 wire 映射、外部响应验证、上游 DeepSeek 字段及字面量密钥行为、每次调用快照、取消、卸载、无回退失败、无需重新注册的设置更改、凭据解析、密钥排除、订阅配置不完整及有效基础加 FI 组合。客户端测试覆盖所有提供方选择、密码呈现、自定义凭据引用、过期响应拒绝、设置写入拒绝、订阅配置、凭据移除呈现，以及 FI 遮蔽内置卡片时只有一个卡片胜出。Desktop 测试覆盖私有 FI 包闭包、必需包拒绝、固定默认组合和旧前缀迁移。独立 Host 和客户端包构建覆盖两个编译面。无密钥订阅快照通过 `fi-preferred-search` 运行，并保留已记录的 Session 输出。通过生产适配器执行的一次真实查询从 Parallel、Tavily、Exa、Serper 和 Brave 返回了标准化来源，且未暴露或存储所提供的密钥。一次 bundled Web 启动渲染了包含全部提供方选项的单个搜索卡片，且无浏览器错误。
