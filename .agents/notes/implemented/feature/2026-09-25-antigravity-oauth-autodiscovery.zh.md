# Agent Note: Antigravity OAuth 客户端本地安装自动发现

Status: implemented

[English](2026-09-25-antigravity-oauth-autodiscovery.md) | 中文

## Problem

[此前的 Agent Note](../bug-fix/2026-09-25-antigravity-oauth-client-configuration.zh.md) 把 Antigravity 的 Google OAuth 客户端 id 与密钥从仓库字面量迁移到了 `ANTIGRAVITY_OAUTH_CLIENT_ID`/`ANTIGRAVITY_OAUTH_CLIENT_SECRET`，经 `ctx.credentials` 或启动环境解析。这关闭了密钥扫描的暴露面，但让每个用户在 Antigravity 登录生效前都必须手动设置这两个值——这一步在源头的 Antigravity CLI 中并不存在，因为它自带已安装应用客户端。已经在本地安装了 Antigravity CLI 或应用的用户，磁盘上就存在同一个客户端；而 fi 此前没有办法找到并复用它。

## Decision

`packages/fi/llm-antigravity/src/auth/discovery.ts` 增加了本地安装自动发现能力，仅在 `resolveAntigravityOAuthClient`（`index.ts`）两个引用都未解析出值时才会触发：对已知 Antigravity CLI/应用安装位置进行有界扫描，寻找 CLI 自身携带的同一个已安装应用 OAuth 客户端，并在信任之前先以 SHA-256 指纹验证。

- **位置**是 `FiAntigravityConfig.oauthClientDiscoveryLocations`（`Volatile<string[]>`）列表，按平台给出默认值（`defaultAntigravityDiscoveryLocations`）：所有平台通用的 `which:agy`（`PATH` 查找）与 `~/.local/bin/agy`，再加上 macOS 的 `.app` 包、Linux 的 share/opt/flatpak/snap 路径，或 Windows 的 `Programs`/`Program Files` 安装目录。目录根节点在固定的深度与文件总量预算内递归遍历（这是扫描本身的鲁棒性边界，而非部署选择，因此保留为模块常量而非 Config 字段），而不是对 `app.asar`、`app.asar.unpacked`、`Contents/Resources/bin/*` 做特殊处理——通用遍历在已配置的根节点内会自然找到全部这些位置。
- **提取**以分块方式流式读取每个候选文件（匹配到的二进制文件可能约有 180 MB），按 `latin1` 解码，使每个字节都映射为一个码点——这正是在二进制数据块中扫描纯 ASCII 模式的正确解码方式——并用一个滑动窗口衔接分块边界。超过 `oauthClientDiscoveryMaxFileBytes` 的文件会被跳过而不读取。
- **验证**对每个提取出的候选 id 与密钥计算 SHA-256，并将累积的哈希值与 `oauthClientDiscoveryFingerprints`（`Volatile<AntigravityOAuthFingerprintPair[]>`）比对，默认即 Antigravity CLI 已知客户端的一对指纹。二进制文件中会携带不止一个 id/密钥，因此候选值会在所有已扫描文件中持续累积，直到某一对被判定完整为止；一旦某个已配置的对完整，扫描立即停止。接受一个被轮换的客户端，只需把它的指纹对加入该 Config 字段，绝不修改默认值。
- **持久化**：`discoverAndPersistAntigravityOAuthClient` 仅在 `ctx.credentials` 已挂载时才运行发现（没有它就无处可持久化写入），匹配成功后会先对两个引用调用 `ctx.credentials.set` 再返回这对值——因此之后的解析会跳过扫描。发现仅在**两个**引用都未配置时触发；部分配置的客户端（一个引用已设置、另一个未设置）仍走既有的显式失败路径，绝不会被静默覆盖。
- **单飞与负缓存**：`runAntigravityDiscovery` 持有一个模块级的进行中 Promise，使并发的解析共享同一次扫描；失败的扫描会被缓存 `oauthClientDiscoveryNegativeCacheMs`，因此一连串失败的解析不会在每次调用时都重新遍历文件系统。
- **日志**：每次日志调用只携带路径或结果，绝不携带匹配到的值；`discoverAntigravityOAuthClient` 的 logger 参数是一个结构化匹配 `ctx.logger` 的双方法接口，使该模块无需依赖 `cordis`。
- 绝不生成子进程执行被扫描的文件；只读取其字节。
- 既有的"未配置"错误（`resolveAntigravityOAuthClient`）被扩展了一句指向此回退路径的说明，而非被替换。
- Desktop 已经运行同一个 Host 插件，因此无需单独接线即可覆盖 Desktop；既有的可选构建期内嵌（`apps/desktop/electron-builder.config.mjs`）保持不变，只要它打包了两个值，仍然优先生效。

## Alternatives considered

- **把指纹值本身作为客户端 id/密钥发布，以一个可选标志门控** — 已否决：这会重新引入此前 Agent Note 移除的那个确切仓库字面量；SHA-256 指纹是"已知客户端"唯一可安全提交的形式。
- **按文件名或安装清单元数据匹配，而非按内容指纹** — 已否决：二进制中嵌入的字符串是观察到的、在一次安装中保持稳定的唯一值；文件名与清单布局都不属于本包所拥有的任何兼容性契约。
- **不加过滤地遍历每个已配置的宽泛根目录（`/usr/share`、`/opt`）** — 已否决：即使该根目录下真的存在 Antigravity 安装，其无关内容也会在到达它之前耗尽大部分文件预算；默认值改为直接给出可能的 Antigravity 专属子路径。
- **将发现结果持久化到 `.env` 文件而非通过 `ctx.credentials`** — 已否决：fi 管理的其他每一个凭据都已经经过凭据接缝的可写本地提供方，该提供方在结构上就位于 fi home 目录、处于任何仓库之外；再建一条持久化路径只会重复这一保证而无额外收益。
- **每次解析失败都重试发现，不设缓存** — 已否决：没有本地 Antigravity 安装且未配置客户端的部署，会在每次登录尝试与每次临近过期的刷新检查时都重新遍历文件系统；负缓存约束了这一成本。

## Testing

| Evidence | Behaviour |
|---|---|
| [discovery.host.spec.ts](../../../../packages/fi/llm-antigravity/tests/discovery.host.spec.ts) | 扫描由运行时拼接而成的虚构 id/密钥片段构建出的合成夹具文件（本仓库源码中从不存在与密钥扫描模式匹配的字面量）；验证指纹匹配、`maxFileBytes` 上限、符号链接环安全、单飞去重与负缓存。 |
| [plugin.host.spec.ts](../../../../packages/fi/llm-antigravity/tests/plugin.host.spec.ts) | `harness()` 禁用发现（`oauthClientDiscoveryLocations: []`），使既有的显式失败与授权解析测试保持隔离，不受测试主机本地实际安装情况影响。 |
| [flow.host.spec.ts](../../../../packages/fi/llm-antigravity/tests/flow.host.spec.ts) | "显式失败"登录测试同样出于此原因传入 `DISABLED_ANTIGRAVITY_DISCOVERY`。 |
| [verify-no-secrets.spec.ts](../../../../scripts/verify-no-secrets.spec.ts) | 随本功能一并新增的仓库密钥防护（见下方独立小节）会拒绝本包测试所用的同种虚构、运行时拼接的夹具形态，证明本包的测试与源码都不会提交匹配的字面量。 |

## Repository secret guard

除自动发现外，`scripts/verify-no-secrets.ts` 会扫描暂存内容（`--staged`，接入 `lefthook.yml` 的 pre-commit 任务）与即将推送的差异（`--push`，接入 pre-push），查找 Google OAuth 客户端密钥、Google OAuth 客户端 id、Google API key 或私钥头；另有 `--tree` 模式（`pnpm run verify-no-secrets`，接入 `scripts/run-gates.ts` 的 `ciSharedStaticGates`）审计所有受跟踪文件的完整内容。两个钩子模式只扫描差异中新增的行——已提交的内容不会在之后每次提交时被重复标记——解析自 `git diff -U0` 的输出；`--tree` 没有这样的历史可依赖。一份显式的、经过评审的许可名单（以精确的仓库相对路径与模式名称为键，绝非目录前缀）用于豁免经评审确认为虚构的夹具；像本功能自身测试那样由运行时拼接构建的夹具则完全不需要这类条目，因为其源码文本从未真正拼出被匹配的模式。

## Consequences

已在本地安装 Antigravity CLI 或应用的用户可以无需任何手动配置直接登录；安装或启动其中之一即可。既未配置引用、本地也未安装 Antigravity 的部署，仍会得到与此前相同的显式失败错误，现在会额外指出这条自动发现回退路径。发现成本按每次扫描设有边界（深度、文件总量、单文件大小），并按进程摊销为每个负缓存周期至多一次扫描；接受一个被轮换的 Antigravity 客户端，只需把它的指纹对加入 `FiAntigravityConfig.oauthClientDiscoveryFingerprints`，无需修改代码。仓库密钥防护是防止未来某个字面量凭据进入 git 历史的第二道独立防线，与 GitHub 自身的密钥扫描互为补充。
