---
description: "面向模型、有界检查当前规范 Workspace 诊断的工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-problems

[English](README.md) | 中文

## 概述

`dsh-tool-problems` 注册无参数 `problems` 工具。它从实时 agent Session 推导 Workspace，通过 `ctx.fs` 解析路径，读取规范 `ctx.problems` 快照，并返回有界、顺序确定的文本。在模型调用工具前，不会有诊断进入模型上下文。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在具备 `fs`、`problems`、`systemPrompt` 和 `tools` 的完整 agent preset 中挂载本包。`maxProblems` 默认为 100，`maxResultChars` 默认为 16,000 个 Unicode 码点。缺少 Session Workspace 会使调用失败；工具参数永不接受路径作用域。

<a id="model-experience"></a>
## 模型体验

### Workspace 诊断指导

#### 模型所见

一个稳定的系统提示段：

##### 诊断检查指导

```markdown
Use problems after code edits or task runs to inspect current Workspace diagnostics. It returns a bounded snapshot only when called; do not assume no diagnostics exist before their producers run.
```

#### Token 影响

本包挂载时使用固定提示 token；`minimal` 省略它们。

#### KV Cache 影响

只要段落文本与顺序不变，前缀保持稳定。挂载或移除本包会改变请求前缀。

### `problems` 工具与结果

#### 模型所见

无参数的 `problems` schema，以及按需生成的结果，其中包含修订版本、总数、严重性、文件位置、来源、代码与消息。控制字符会转义，被省略条目会计数，超量文本会标记为截断。

#### Token 影响

挂载时有一个固定 schema。每次调用追加一个由 `maxProblems` 与 `maxResultChars` 限制的结果；调用前没有结果进入上下文。

#### KV Cache 影响

Schema token 在注册不变时保持前缀稳定。已记录调用与结果追加在可复用前缀之后；部署结果限制会改变调用输出，不改变 schema。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 检查按需进行；工具不会运行生产方，也不表示生产方发布前诊断已是最新。
- 输出是文本，不是修改或编辑器协议。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
