# Agent Note: fi 首次运行不再依赖 DeepSeek 账号

Status: implemented

[English](2026-09-25-fi-first-run-without-deepseek-account.md) | 中文

## Problem

fi 是构建在 vendored DeepSeek Harness（DSH）运行时之上的模型无关（model-universal）产品，但它的首次启动流程此前仍在沿用 DSH 自身的引导流程：打包后的 Desktop 应用会打开一个原生欢迎窗口（`apps/desktop/src/welcome-window.ts`），要求用户先完成 DeepSeek 账号登录或填写 DeepSeek API Key 才能继续（`welcome-api.ts` 的 `needsWelcome`）；即便跳过这一关，内嵌的工作区仍会挂载 DSH 自带的 DeepSeek 账号设置 UI（`packages/client/ui-settings-account`）及其 Remote（`packages/api/account-controller`）——账号菜单、余额不足提示、Models 页面的登录入口，以及一个 desktop-onboarding 引导层，这些全部围绕 fi 并不提供的 DeepSeek Platform 账号设计。非 DeepSeek Platform 用户完全无法跳过首次运行。

通用的 Web 引导步骤其实已经存在，并且是模型无关的：`packages/client/ui-settings-models` 的 `ModelSetupDialog` 会把未配置模型的用户引导至 Models 页面，而不收集任何特定厂商的凭据。但它此前从未在 Desktop 内运行，因为它的自动展示条件默认只要出现 `dshDesktop` 全局变量，就说明该壳层已拥有自己的首次运行引导——这个假设对 DSH 自己的 Desktop 成立，但在上述 DeepSeek 网关被关闭后，对 fi 已不再成立。

## Decision

`needsWelcome`（`apps/desktop/src/welcome-api.ts`）被固定为 `false`，背后是一个有文档说明的 `FI_NATIVE_WELCOME_DISABLED` 常量：在所有此前需要判断是否展示原生欢迎窗口的代码路径上，fi 的 Desktop 都会从 Host 启动后直接进入工作区。原生窗口的实现（`welcome-window.ts`、`welcome-backend.ts`、`preload-welcome.ts` 及其渲染进程代码）仍保留在代码树中——`needsWelcome` 是它唯一面向调用方的开关，且每个调用方都已经经过它——但只要该常量为真，它就不会注册任何 IPC，也不会显示任何窗口。`main.ts` 的 Host 启动处理函数不再订阅 DeepSeek 账号状态（`accountBackend.watch(...)`）：这个订阅原本只是为了在登出或会话过期时重新打开欢迎窗口，而网关关闭后这两种情况都不可达；而且它调用的 Remote（`account-controller`）已经在 fi 自己的 bundle 中被禁用（见下文），继续保留这一订阅只会不断轮询一个已经不存在的命名空间。`welcome-backend.ts` 的 `read()`——在网关关闭后仍被保留用来做仅存的两件事：启动时读取已保存的语言偏好，以及响应 `dsh-desktop:onboarding-api-key` 这个 IPC 探测——不再为了 `loggedIn` 字段去 `await account.state()`（fi 从不读取这个字段），而是直接返回 `false`。

`packages/fi/authorization-bundle/cordis.patch.yml`——它是应用到 `web` 和 `desktop` 两个 profile 的最后一层 bundle（`packages/boot/app-boot/src/profile.ts` 中的 `PROFILE_TEMPLATES.web`；`apps/desktop/src/desktop-profile.ts` 中的 `DESKTOP_PROFILE_BUNDLES`）——禁用了上游 `base`/`web-app` bundle 挂载的四行：`ui-settings-account` 与 `account-controller`（DeepSeek 账号设置 UI 及其 Remote），以及 `deepseek-account` 与 `llm-deepseek-account`（Host 端账号服务及其基于账号的 LLM 路由）。这与该文件此前禁用 `web-search-deepseek` 使用的是同一种机制，且不改动上游 bundle 文件本身。`llm-deepseek`（API Key 路由）未受影响，因此用户仍可在 Models 页面用自己的 API Key 把 DeepSeek 当作一个普通 provider 使用。禁用 `deepseek-account` 同时也让原生 “Platform” 页面的通道（`apps/desktop/src/platform-view.ts`、Host 端的 `'platform-session'` IPC 事件）失去唯一的调用方——这套通道此前只被 `ui-settings-account` 的充值/续费页面调用；插件被禁用后不再有任何代码调用它，这与 Linux 版 Desktop 今天的既有状态完全一致，因为 `deepseek-account` 的 `desktopPlatform` 配置在 macOS/Windows 之外本就恒为 `null`。

`packages/client/ui-settings-models` 的 `automaticModelSetup` 不再排除 `dshDesktop`，现在就等于 `configured.credentialOnboarding`。该包内部用于内测的 `WelcomeNotice` 步骤保留其原本与本次改动无关的 Web-only 排除条件（`!('dshDesktop' in globalThis)`）。因此 `ModelSetupDialog` 成为 fi 在所有场景下唯一的首次运行凭据步骤：Web 与 Desktop 行为完全一致。

对仍然存在的“DeepSeek Harness”用户可见文案做了一次排查，并修复了在 fi 构建中仍处于活跃状态的部分：`apps/desktop/src/locale.ts` 的 `welcome*` 文案（在正常流程下已不可达，但由于原生窗口仍保留在代码树中，仍一并修复）、`ui-plugin-manager` 的插件安装风险提示文案，以及 `ui-sidebar-documentpreview` 的 Office 预览不可用文案，中英文均已修正。`ui-settings-account` 自身的文案保持原样：该插件在 fi 中已被完全禁用，修改一个已禁用插件的文案只会在它仍与上游 vendored 源码保持一致时制造不必要的合并冲突。打包后应用的窗口/文档标题无需改动即已显示 “fi”——`scripts/client-build-environment.ts` 的 `OFFICIAL_CLIENT_BUILD_ENVIRONMENT` 早已设置 `DSH_CLIENT_TITLE: 'fi'`，`apps/desktop/scripts/package-target.ts` 也早已通过 `pnpm run build:official` 构建；字面的 “DSH Local Build” 兜底文案作为非正式/本地开发构建的标签本身是正确的，无需改动。

### 模型可见的 DSH/fi 运行时说明

另外，`packages/core/system-prompt/src/index.ts` 中固定的 `harness:identity` 开场白在 `You are an AI agent powered by fi.` 之后新增了一句：其工具、技能、`DSH_*` 环境变量、`dsh` CLI 以及 `@deepseek-ai/dsh-*` 包名此前仍然全部以 DeepSeek Harness 命名,而只有开场白本身说的是 fi；有用户反馈应用内的 agent 会把 DSH 当成另一个独立产品，去寻找一个并不存在的 “DSH 源码仓库” 或 `$DSH_HOME/.agent-presets`。新增的句子说明 `dsh`、`DSH_*` 变量与 `@deepseek-ai/dsh-*` 包都是 fi 自身的运行时，而非另一个独立产品或独立代码检出，并说明 `$DSH_HOME` 就是 fi 的数据主目录；`editing-cordis-compositions` 的 `SKILL.md` 也补了一个从句作为前置条件，使其 “迁移旧版 preset” 一节不再在该目录并不存在时把模型引导过去查看。所有固定该提示词的 `system-prompt.expected.md`，以及唯一受影响、同时嵌有该 `SKILL.md` 正文的 `.jsonl` 夹具，都是手工编辑匹配的，而非重新录制——因为 `test:snapshot:record` 需要一把此环境没有的真实模型 API key，而且会顺带改写无关的已录制内容。

这一改动与 [fi agent 自我认同](2026-09-10-fi-agent-self-identification.zh.md) 中“在开场白里说明具体实现”这一被否决的备选方案并存，而不是推翻它：该记录保留的固定认同句本身不携带任何实现层面的品牌信息，此处仍然是一字不差的 `You are an AI agent powered by fi.`。新增的这句话是另外独立的第二句，解决的是一个不同的问题——一个已经知道自己是 fi 的模型，仍然需要正确理解它在工具中会看到的具体字符串（`dsh`、`DSH_*`、`@deepseek-ai/dsh-*`），否则会把这些当成存在第二个产品的证据；这与模型对自身身份的陈述是两件事。

## Alternatives considered

**直接删除整个原生欢迎窗口子系统，而不是用开关关闭它。** 已否决：`welcome-backend.ts` 的 `read()`/`readLocalePreference()` 还承担着与 DeepSeek 网关无关的职责——启动时的语言偏好读取，以及 `dsh-desktop:onboarding-api-key` 这个 IPC 探测；彻底删除还需要把这部分逻辑迁移到别处，相比直接固定住那个已经统管所有调用方的判断函数，并没有带来行为上的收益。

**保留 `needsWelcome` 真实的布尔逻辑，转而分别在 `main.ts` 的三处调用点上加开关。** 已否决：负责在登出/会话过期时重新打开欢迎窗口的账号状态订阅，本身根本不经过 `needsWelcome` 判断——它在 Host 启动后就无条件运行；只在 `needsWelcome` 调用点加开关，会让这个订阅继续轮询一个 fi 已经禁用的 Remote 命名空间。两处都必须处理，而在移除该订阅之后，直接固定住这一个决策函数是更小、单一来源的改法。

**通过直接修改 `packages/bundle/base`/`packages/bundle/web-app` 来禁用 `deepseek-account`/`account-controller`。** 已否决，理由是本仓库既有的约定：这些 bundle 需要保持与上游 DeepSeek Harness 组合可合并；fi 的产品差异应当放在 `packages/fi/authorization-bundle` 的 patch 层中——该文件此前已经用同样的方式禁用过 `web-search-deepseek`，并且在 `web` 与 `desktop` 两个 profile 中都是最后一层。

**为 `ModelSetupDialog` 的自动展示新增一个显式 Host 配置开关，而不是直接去掉 `dshDesktop` 判断。** 曾经考虑过，但 Desktop 的内嵌浏览器与普通 Web 部署共享完全相同的 `base`+`web-app` Host 组合与 Remote 接口——对于一个在启动时一次性写入 `webserver/index-inject` 的值来说，Host 侧并没有任何信号能够区分“这个 Host 正在服务 Desktop 内嵌视图”还是“这个 Host 正在服务浏览器标签页”。只有客户端侧的 `dshDesktop` 全局变量能可靠地知道这一点；既然 fi 已经不再需要对 Desktop 区别对待，去掉这个特例才是准确的做法。

## Consequences

fi 的 Desktop 每次启动都会直接进入工作区，不再出现 DeepSeek 账号或 API Key 提示；`ModelSetupDialog` 是唯一的首次运行凭据步骤，Web 与 Desktop 行为一致。fi 组装出的 Web 或 Desktop 应用中不再渲染任何 DeepSeek 账号 UI、登录流程、余额不足提示或充值到账提示；DeepSeek 本身仍可作为普通的 API Key provider 被配置。被停用的原生欢迎窗口的 IPC、渲染进程代码与测试仍保留在代码树中，作为 `needsWelcome` 永不调用的惰性基础设施——未来若某个产品想重新启用原生 DeepSeek 账号网关，可以把 `FI_NATIVE_WELCOME_DISABLED` 改回去，不过它的 `WELCOME_IPC.state` 实时状态推送逻辑（已从 `main.ts` 的账号订阅中移除）以及退出确认取消路径中重新展示欢迎窗口的逻辑（`main.ts` 的 `before-quit`）都需要重新验证，因为本次改动都没有实际执行到它们。`deepseek-account` 的原生 Platform 页面（充值/续费）在 fi 中不可用，这与 Linux 版 Desktop 目前在所有平台上的既有行为一致。
