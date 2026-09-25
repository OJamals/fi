# Agent Note：模型设置中的订阅 OAuth 登录

Status: implemented

[English](2026-09-11-subscription-oauth-sign-in.md) | 中文

## Problem

订阅账户需要交互式授权和存储的授权记录，通用 Models 编辑器则配置 API-key 路由。登录、路由设置与恢复需要统一界面，同时不能把提供方认证移入 agent loop 或改变持久化 Session 数据。

## Decision

订阅登录使用现有授权、凭据、设置与 LLM 服务。[FI 授权 bundle](../../../../packages/fi/authorization-bundle/README.zh.md) 在上游 base bundle 之后组合 FI 自有插件。base bundle、agent loop、已发布的 Session 格式与 SDK 投影保留上游行为。

[授权控制器](../../../../packages/fi/api-authorization-controller/README.zh.md) 独立于凭据存储，拥有自己的 Remote 命名空间。每个 `begin` 流承载发起调用方的通知、提问和一次结算。一元方法返回 Remote 结果信封；客户端先检查 `ok` 再读取值。线上方法名为 `revoke`，因为 `remove` 是 Remote 命名空间服务的保留名。

[登录界面](../../../../packages/fi/client-ui-model-signin/README.zh.md) 只占用一个 Models 页脚。Claude、Codex、Grok 和 Antigravity 共享同一套交互状态。Models 页面把可用 OAuth 流程中未带 `apiKeyEnv` 的已配置路由放在登录控件下方；API 密钥 profile 留在主列表。两个位置共用路由编辑器与删除流程。产品文案由类型化语言字典拥有，控件使用应用主题 token 和响应式布局。

FI 包保留为私有 workspace 组，不因位于 `packages/` 下就成为上游 npm 发布成员。显式的命名空间与私有性检查防止意外发布，同时保留普通包、构件和上游发布验证。

## Consequences

pi-ai 拥有其 OAuth 记录和串行化刷新。[Antigravity 适配器](../../../../packages/fi/llm-antigravity/README.zh.md) 拥有 `fi-antigravity` 设置命名空间、限定作用域的授权与项目发现。其持久化记录解析器接受已文档化的历史项目键名；刷新在凭据存储的串行修改内重新检查记录。

授权提交与路由采用彼此独立。采用通过预期设置修订号写入缺失路由，保留并发编辑。模型发现失败时报告经过脱敏、可重试的错误，不删除授权或路由。已登录账户可以重试设置，无需重复 OAuth。撤销只删除授权，保留用户拥有的模型配置。

界面区分运行中的操作与已结算的尝试。操作标识阻止迟到的回答、取消错误和采用结果影响后续尝试。加载代次阻止过期或销毁后的读取发布状态。刷新使过时的采用横幅失效，失败保持可见并提供恢复操作。

## 组合与生命周期

客户端先挂载自己的 Remote contribution，再在限定作用域的 fiber 内注入已挂载命名空间。槽位注册等待其声明者就绪并返回 disposer。可用 OAuth 路由列表通过 Models 页面的订阅注册表发布，并随客户端 fiber 一起销毁；缺失的流程不会移动已配置行。凭据记录变更通过现有 Remote 事件允许列表到达浏览器；API-key 引用变更属于另一种事件，不能表达 OAuth 撤销。

已安装的 pi-ai 目录提供 Claude、Codex 和 Grok 登录流程。Antigravity 插件在同一授权服务上注册自己的流程。服务缺失或路由未知时明确失败，不创建凭据或替换为其他提供方。

## Alternatives considered

已有原生适配器服务，本地兼容代理仍会增加监听端口与额外进程，因此实现使用原生适配器。扩展凭据控制器会混合获取授权与存储授权的职责；独立授权控制器保留二者的分工。

登录对话使用调用方拥有的流，而非广播授权事件，因为提问与回复属于单一发起者。Models 页脚列出受支持的订阅流程，不重复通用 API-key 编辑器。

OAuth 状态绝不使用虚构的 API-key 标记。如果路由之后引用该键，标记可能成为 Bearer token。没有 `apiKeyEnv` 的路由依赖适配器的凭据所有者，不表示缺少 API key。

Codex 使用单次请求的 WebSocket 工厂，因为已安装的 SDK 在普通请求头转换后覆盖调用方提供的握手身份。固定版本的依赖补丁暴露最终握手准备，不替换全局网络实现，也不改变未使用该扩展的调用方。FI 保留自动优先 WebSocket、显式传输设置与 HTTP 回退；连接复用按凭据、端点、元数据、代理与连接器所有权隔离。插件只销毁自己的连接。维护中的 SDK 提供等效的单次请求行为后即可移除此补丁。

## 必需验证

提供方兼容处理属于 FI 的[传输元数据插件](../../../../packages/fi/provider-compat/README.zh.md)，通过可选的 pi-ai 适配器扩展实现，不进入共享 LLM 或 agent-loop 接口。认证仍由已安装的凭据实现拥有；订阅传输不能替换为环境 API key，也不能把请求重定向到任意目标。Antigravity 在现有适配器私有重放信封中存储原生签名元数据。文件保留上游请求组装对只读句柄的投影，图像字节则通过附件服务处理。

[原生搜索提供方](../../../../packages/fi/web-search-subscription/README.zh.md) 通过现有 web 服务单独选择。它要求原生搜索完成信息与引用证据，因为仅有模型生成的回答文本不能证明实际执行过搜索。现有 web 工具拥有日志与展示；默认提供方选择保持不变。

auth2api 拥有版本发现逻辑与协议捕获。FI 同步精确的更新器字节并记录来源，不维护第二套实现。公开版本发现不能证明协议指纹变化，因此受捕获约束的设置仅凭经过审查的构件或请求证据推进。定时更新提出元数据变更供审查，不安装未经验证的运行时指纹。

聚焦的 Host 测试覆盖已安装登录流程注册、路由并发、可重试的发现错误及凭据所有权。客户端测试覆盖一元错误、操作替换、销毁、恢复与本地化控件。提供方传输测试通过现有 LLM 接口覆盖重放与附件处理。组合检查覆盖插件注册和销毁；实际浏览器检查独立于组件断言，确认响应式布局与交互行为。
