# Agent 预设指南

[English](agent-presets.md) | 中文

预设定义了一个 agent 会话可以访问哪些工具与能力。

## 预设类型

| 预设 | 说明 |
|--------|-------------|
| `standard` | 具备全部工具的完整 coding agent |
| `minimal` | 固定提示词、仅 shell |
| `comprehensive` | 面向企业工作流的强化预设 |
| `ptc` | 生产测试配置 |

## 预设结构

每个预设是一个目录，包含：

- `agent.cordis.yml` —— 组合文件（必需）
- `preset.yml` —— 元数据（名称、描述）

## 组合规则

### Host 平面与预设平面

**Host 组合**（base.cordis.yml、web.cordis.yml）：

- 注册表（工具、会话、agent）
- 持久化、沙箱、审批栈
- 模型路由
- 跨会话服务

**预设组合**（agent.cordis.yml）：

- 单会话的工具插件
- persona 与提示词分节
- 压缩策略
- 会话本地状态

### Isolate Realm

在预设中发布的任何服务都**必须**位于带有 `isolate` realm 的组内：

```yaml
- id: my-group
  name: cordis:group
  group: true
  isolate:
    myService: true  # Entry-local realm
  config:
    - id: provider-row
      name: '@deepseek-ai/dsh-my-service'
```

没有 `isolate` 时，服务会发布到根 realm（进程全局），从而导致：

- 第二个会话挂载该预设时发生冲突
- Host 读取方解析到错误的实例

### 行分类

| 分类 | 是否需要 Isolate？ | 示例 |
|----------|----------------|---------|
| 工具（消费 Host） | 不需要 | `tool-bash`、`tool-fs` |
| 服务（发布） | **需要** | `plan-mode`、`compaction` |
| Host 提供方 | **需要** | `workflow-worker-thread` |

## 创建自定义预设

1. 复制一个现有预设目录
2. 编辑 `preset.yml` 以更新名称与描述
3. 编辑 `agent.cordis.yml` 以修改组合
4. 用 `standingKeyFor(id)` 验证

## 工具组织

### Shell 工具

- `tool-bash` / `tool-pwsh` —— 一次性命令
- `tool-bash-persistent` / `tool-pwsh-persistent` —— 持久会话

### 文件系统工具

- `tool-fs` —— 读写文件
- `tool-fs-search` —— grep/glob 搜索

### subagent 工具

- `tool-subagent` —— 派生新 agent
- `tool-subagent-fork` —— 继承上下文
- `tool-subagent-control` —— 管理 agent

### 工作流工具

- `tool-workflow` —— 执行工作流
- `tool-ralph` —— 规格驱动的 agent 循环

## 配置选项

### Persona

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a coding assistant.
    suffix: Your working directory is {{cwd}}.
```

### Web 工具

```yaml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    searchTimeoutMs: 60000
```

## 调试

### 挂载验证

```
standingKeyFor('my-preset')
```

返回成功或具体错误：

- `Cannot find package ...` —— 缺少依赖
- `invalid config: ...` —— 配置非法
- `N row(s) did not activate` —— 缺少服务
- `row(s) published process-global service(s)` —— 缺少 isolate realm

### 检查提供方

```
cordis_inspect what:"services"
cordis_inspect what:"api" name:"agentPresets"
```
