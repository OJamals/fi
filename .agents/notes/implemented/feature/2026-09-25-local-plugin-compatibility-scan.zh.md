# Agent Note：本地 Claude 与 Codex 插件兼容性扫描

Status: implemented

[English](2026-09-25-local-plugin-compatibility-scan.md) | 中文

## Problem

本地 Claude Code 与 Codex 插件包含可执行的 hook、MCP 配置、skill 以及各种组件，导入时不能把它们当作可信包对待。fi 已经具备导入插件的贡献将要运行于其上的各个部件——`dsh-skill` 的提供方接缝（其中 `dsh-skill-filesystem` 已能加载一个目录下、按 Claude 格式书写的 `SKILL.md` 文件）、`dsh-mcp-client` 的 stdio/HTTP 服务器 bridge，以及 `dsh-hooks-claude-code`/`dsh-hooks-codex` 的单一 `configPath` 命令 hook bridge——但它们都不会发现某个插件自身的清单布局，也没有任何代码把 Claude 或 Codex 的 MCP 服务器声明转换成 `dsh-mcp-client` 的配置形态。导入器需要一份完整的清单、明确的不受支持诊断、路径包含性、有边界的读取，以及一份用于重新校验的指纹，同时不执行插件内容、不改动源代码树，并且每一次激活都必须是用户做出的决定，而不是由扫描替用户做出的决定。

## Decision

插件兼容性扫描器（`packages/extensions/plugin-compat/src/manifest.ts`）读取一个本地 Claude 或 Codex 插件根目录，返回受支持的 skill、MCP 服务器、命令 hook、不受支持的组件、诊断信息、以 UTF-8 解码的源文本，以及一份基于确切源字节的确定性指纹。当 Claude 默认的 `skills/`、`hooks/hooks.json`、`.mcp.json` 布局存在时，即便没有 `plugin.json`，扫描器也会接受；Codex 的导入则要求存在 `.codex-plugin/plugin.json`。同时存在两种清单的根目录会被判定为有歧义并拒绝。

扫描器使用 fi 已经为 `dsh-skill-filesystem` 依赖的 `yaml` 包解析 skill frontmatter，校验 MCP 的 stdio 与 HTTP 条目，校验受支持的 hook 事件与命令子集，并把不受支持的事件、hook 类型、异步 hook、组件与格式错误的取值记录为诊断信息，而不是悄悄丢弃。它只替换文档中说明过的插件与受信任激活目录占位符。它绝不执行命令、脚本、agent、应用程序、LSP 配置或 MCP 服务器。

扫描器在读取之前会施加可配置的目录项数（`maxEntries`）、文件数、单文件字节数与总字节数上限。每个源路径都要通过词法与 realpath 包含检查，清单所在目录与默认配置路径同样受此检查覆盖。指纹对清单、发现的 skill 文件与资源、以及发现的 MCP 或 hook 配置的确切字节取哈希；保留的源文本以 UTF-8 解码用于解析。激活时会重新扫描同一个本地根目录，因此新增或删除的相关贡献都能被发现；指纹不会证明 hook 脚本本身，也不会证明未被发现为插件源文件的传递依赖。

`PluginCompatService`（`packages/extensions/plugin-compat/src/index.ts`）维护一份持久化的全局文档，外加规范化工作区记录；导入过程从不读取仓库配置，也不会执行插件自身的本地设置。MCP 与 hook 要求显式的逐项启用——导入的 skill 默认启用，因为它在模型选择加载之前只是惰性文本；而导入的 MCP 服务器或 hook 一旦会话组合完成就可能运行本地命令或连接网络服务器，因此默认禁用。变更通过一个队列序列化；释放会等待正在进行的变更完成，并在关闭前拒绝已排队的工作。

`agent/created`——它是本功能早期一条已分叉分支曾称为 `agent/setup` 的扩展点在当前架构下、被串行等待的等价物——是这次组合所用的生命周期接缝（`packages/extensions/plugin-compat/src/runtime.ts` 的 `mountManagedPlugins`，由 `PluginCompatService` 的构造函数调用）。插件挂载会在 agent 发布之前完成，初始化失败会回滚创建，这与 `docs/architecture.md` 的 turn 流程约定一致。这使该功能保持在 agent loop 之外，并保留既有原生 hook bridge 的行为，包括其分离执行的 SessionStart 时机与不受支持的输出控制。每个贡献都作为子插件挂载到组合该会话的 agent 自身的 `agent.ctx` 上（一个随该 agent 释放而卸载其贡献的作用域上下文，与 `dsh-browser-use-runtime` 已用于按 agent 挂载 MCP 的原语相同），因此已解析的 skill、MCP 服务器或 hook 集合永远不会比它所解析的那个 agent 存活得更久。

被选中的 hook 行会把生成的配置写入一个权限为 `0o600` 的私有临时目录，并通过未经修改的 `dsh-hooks-claude-code`/`dsh-hooks-codex` bridge 挂载——与未经修改的部署已经使用的同一套命令 hook 运行器与带类型的决策映射相同。被选中的 MCP 服务器通过未经修改的 `dsh-mcp-client` 挂载，把发现的 `command`/`args`/`env`/`cwd` 或 `url`/`headers` 形态转换为其 `StdioConfig`/`StreamableHttpConfig`。被选中的 skill 直接调用 `dsh-skill` 的 `ctx.skills.register()`，并标注 `claude-plugin`/`codex-plugin` 这一 `SkillSource`，同时在 metadata 中记录所属插件的 id。

本包不发布任何包自有的 `./invariant` 伴生入口。`packages/AGENTS.md` 的不变式规则现在会拒绝一个仅包含空检查或固定示例探测的安装器；本包的持久化状态已经由其持久化文档的 `zod` schema（读取时拒绝）与每次激活时的指纹重校验（挂载时拒绝）覆盖，单独的伴生入口只会重复包装已有检查，而不会报告一个独立的、可能出现分歧的观测点。相应理由改为写在本包的 README 中，遵循同一条规则。

本次变更唯一提供的同意界面是五个全局作用域的 `dsh-commands` 注册（`/plugin-import`、`/plugin-list`、`/plugin-enable`、`/plugin-disable`、`/plugin-remove`），而不是浏览器端的设置界面。`PluginCompatService` 的公共方法——包括工作区级选择与逐项覆盖重置——与一张等价设置卡片所需的能力相比并无变化，因此未来的卡片可以直接驱动它们；相对于本功能早期一条已分叉分支构建的、支持两种作用域与覆盖感知的卡片，本次变更缩减的只是随附的界面本身。

## Alternatives considered

- **信任插件清单并执行其中声明的条目**——被否决，因为本地插件内容就是可执行代码，导入必须始终是一次检查操作。
- **扫描插件根目录下的每一个文件**——被否决，因为包缓存与不相关文件会让扫描变得无边界，并把信任面扩大到超出已声明插件组件的范围。
- **悄悄省略不受支持的组件**——被否决，因为清单的使用者会看到不完整的画面，激活也可能声称支持实际并不存在的能力。
- **在本次变更中随附浏览器设置界面**——推迟。`dsh-commands` 已经提供了一个有文档、有测试的、由人触发变更的扩展点，先构建它能让每一项安全属性（有边界的扫描、路径包含性、不执行、逐项默认关闭的同意、指纹重校验）都可以独立于客户端界面范围接受审查；针对同一套 `PluginCompatService` 方法构建设置卡片是未被阻塞的后续工作。
- **发布一个与早期已分叉分支一致的空 `./invariant` 伴生入口**——被否决：收紧后的不变式规则（`packages/AGENTS.md`）现在会把没有独立分歧观测点的安装器视为无效，而本包既有的两项检查（文档 schema、指纹重校验）已经覆盖了伴生入口本应保留所有权的那部分状态。

## Consequences

有效的插件可以带着针对不受支持条目的警告完成导入，而格式错误的受支持条目与不安全路径都会失败并阻断。默认与清单声明的 Claude skill 是增量式的。源代码树保持不变，清单为相关文件保留确切字节。脚本与依赖的完整性仍在该指纹范围之外，需要后续的执行完整性设计来覆盖。

首个发布版本仅支持本地：市场解析与完整的供应商模拟仍在本包之外。一个声明了 Harness 无法映射的执行限制的 skill 会一直保持可见但不受支持的状态，绝不会被注册为普通可运行的 skill。选择启用某个 MCP 服务器或 hook 始终是通过命令做出的有意行为，绝不是导入或列出插件的副作用。
