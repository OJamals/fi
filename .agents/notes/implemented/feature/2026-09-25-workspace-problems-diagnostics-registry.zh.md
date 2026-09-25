# Agent Note: Workspace 诊断注册表（`ctx.problems`）及其模型工具

Status: implemented

[English](2026-09-25-workspace-problems-diagnostics-registry.md) | 中文

## 问题

一条较旧的、现已被取代的 GUI 分支（`codex/model-universal`）构建了一套 coding-controller 子系统：诊断注册表、带有成败验证与运行历史的项目任务运行器、覆盖两者的模型工具、浏览器 BFF，以及五列工作台客户端 UI。针对本 fork 的审计发现 `main` 上没有等价能力：`packages/lsp` 有意将诊断从其只读导航工具中排除，`packages/jobs` 只运行任意后台命令、没有诊断来源概念，而 `packages/goal`/`packages/schedule`/`packages/workflow` 分别追踪目标、跟进项与多阶段运行，都不是诊断注册表。模型或未来的生产方（lint 运行器、任务失败解析器、LSP 诊断转发）无处为某个 Workspace 发布结构化诊断，也没有工具可以读回它们。

## 决策

从已被取代的分支移植该注册表及其消费方，并使其适配本 fork 当前的约定，形成两个包：[`packages/core/problems`](../../../../packages/core/problems/README.zh.md)（`ctx.problems`）与 [`packages/core/tool-problems`](../../../../packages/core/tool-problems/README.zh.md)（`problems` 工具）。`Problems` 为每个规范 Workspace 根保存一个来源映射；生产方调用 `replace(workspaceRoot, source, problems)` 提交自己当前的完整贡献（空贡献即清除），`inspect()`/`subscribe()` 则向消费方提供分离且顺序确定的快照（严重性、路径、位置、来源、代码、消息），且只有在可见内容真正变化时才递增其 `revision`。`dsh-tool-problems` 从调用方 agent 的 Session 推导 Workspace，通过 `ctx.fs` 解析，并渲染有界、带截断标记的结果；新增的 `TOOL_PROBLEMS` 系统提示段顺序（2500，位于 `TOOL_GOAL` 与 `TOOL_WORKFLOW` 之间）承载其唯一的稳定指导文本。

两个包均以可用、可选挂载的能力形式发布——与 `dsh-lsp`/`dsh-tool-lsp` 一样，默认未挂载进任何随附组合包（`dsh-base`、`dsh-web-app`、`dsh-headless`、`dsh-sdk-app`、`dsh-acp-app`），因此本变更不触及任何无密钥录制的会话快照。本变更也未随附任何生产方：`problems` 是一个完整的双角色接缝（Service Definition/Provider 合并于 `dsh-problems`，Consumer 为 `dsh-tool-problems`），在部署方挂载生产方之前会返回“无”，这正是其自身模型体验小节所记录的行为。

## 已考虑的替代方案

**移植完整的 coding-controller 子系统（任务运行器、任务验证、tool-tasks、浏览器 BFF、客户端工作台）**——本次变更中已否决。已被取代分支的客户端包（`client/ui-problems`、`client/ui-tasks`）注册进一个 `workbench` slot 家族，并调用 `ctx.layout.openWorkbench(...)`；`main` 当前的 `dsh-client-ui-layout` 是三列式 `AppFrame`，整棵树中不存在 `workbench` slot 或 `openWorkbench` 方法，因此该 UI 无法直接移植，只能针对 `dsh-client-ui-dockkit`/侧栏体系重新设计——这是另一项更大的独立工作。任务运行器的本地提供方（`jobs/task-runner-local`）是针对旧分支的 `ctx.jobs` 编写的；`main` 当前的 `JobRegistry.start(spec: JobSpec)`（拉取式 `output` 来源、`run(job): JobHooks` 启动器、`owner: SessionId` 而非实时 `Agent`）形状不同，任务运行器还需要 Git 修订观测、诊断解析与会话日志运行历史投影——这些新增设计面足以配得上自己独立、范围明确的 PR，而不是在“保持范围紧凑”的指示下捆绑进本次变更。只移植注册表及其读取方即可在避免上述全部工作的同时，弥补诊断这一半的缺口。

**在同一变更中接入一个生产方（例如把 `dsh-lsp-stdio` 的诊断通知转发进 `ctx.problems`）**——本次变更中已否决：`dsh-lsp` 的 Service Definition 有意将诊断排除在其请求/响应词汇之外，接入转发就意味着扩大该接缝的约定，这超出了新增注册表本身的范围。该注册表本就应在零生产方挂载的情况下依然有用，这正是其 `problems` 工具结果已经记录的行为。

**默认将 `dsh-problems`/`dsh-tool-problems` 注册进 `dsh-base`**——已否决：本 fork 目前尚无任何东西向该注册表投喂数据，默认挂载的 `problems` 工具将永远只会回答“无”——这是一个真实的答案，但并不明显比工具完全不存在更有用。让两者都保持未挂载（就像同样需要外部配置才有意义的 `dsh-lsp`/`dsh-tool-lsp`）能让它保持为一项可用能力，供未来的生产方配对使用，而不会拉高每个随附 agent 的工具数量，也不会触及今天的任何快照固定文件。

## 后果

未来的诊断生产方（lint 运行器、任务失败解析器、LSP 转发）有了一个规范位置可以按 Workspace 发布结构化、有界的诊断，也有了一个规范的模型工具可以读回它们；该生产方到来时两个包都无需改动。两份 README 的“已知限制”小节均明确说明目前没有随附的生产方，读者不会把“工具回答无”误读为“该 Workspace 没有诊断”。原子系统中任务运行器/任务验证/tool-tasks/coding-controller/客户端工作台的那一半仍未移植；未来若要实现带验证的项目任务执行，需要针对 `main` 当前的 `ctx.jobs` 形状与会话投影接缝撰写自己的 Agent Note，并自行决定工作台 UI 是否值得基于 `dsh-client-ui-dockkit` 重建，还是只停留在 host/工具侧。

## 所需验证

单元测试覆盖了注册表的原子替换/检查/订阅语义、其按来源与按 Workspace 的限制，以及监听器隔离，位于 [`packages/core/problems/tests/problems.spec.ts`](../../../../packages/core/problems/tests/problems.spec.ts)。工具的注册、提示段、Workspace cwd 推导（包括通过桩化的 `ctx.fs` 解析别名）、渲染顺序、截断，以及无 Session Workspace 时的失败路径，覆盖于 [`packages/core/tool-problems/tests/tool-problems.spec.ts`](../../../../packages/core/tool-problems/tests/tool-problems.spec.ts)。新增的 `TOOL_PROBLEMS` 段落顺序常量由 [`packages/core/system-prompt/tests/system-prompt.spec.ts`](../../../../packages/core/system-prompt/tests/system-prompt.spec.ts) 中既有的唯一性/间距断言覆盖。
