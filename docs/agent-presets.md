# Agent Presets Guide

English | [中文](agent-presets.zh.md)

Presets define what tools and capabilities an agent session has access to.

## Preset Types

| Preset | Description |
|--------|-------------|
| `standard` | Full coding agent with all tools |
| `minimal` | Fixed prompt, shell-only |
| `comprehensive` | Opinionated enterprise workflow preset |
| `ptc` | Production testing configuration |

## Preset Structure

Each preset is a directory containing:

- `agent.cordis.yml` - The composition file (required)
- `preset.yml` - Metadata (name, description)

## Composition Rules

### Host vs. Preset Plane

**Host composition** (base.cordis.yml, web.cordis.yml):
- Registries (tools, sessions, agents)
- Persistence, sandbox, approval stack
- Model route
- Cross-session services

**Preset composition** (agent.cordis.yml):
- Per-session tool plugins
- Persona and prompt sections
- Compaction policies
- Session-local state

### Isolate Realms

Any service published in a preset **must** sit inside a group with an `isolate` realm:

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

Without `isolate`, the service publishes into the root realm (process-global), which causes:
- Collision on second session mounting the preset
- Host readers resolving the wrong instance

### Row Categories

| Category | Needs Isolate? | Example |
|----------|----------------|---------|
| Tools (consume host) | No | `tool-bash`, `tool-fs` |
| Services (publish) | **Yes** | `plan-mode`, `compaction` |
| Host providers | **Yes** | `workflow-worker-thread` |

## Creating a Custom Preset

1. Copy an existing preset directory
2. Edit `preset.yml` to update name/description
3. Edit `agent.cordis.yml` to modify composition
4. Validate with `standingKeyFor(id)`

## Tool Organization

### Shell Tools
- `tool-bash` / `tool-pwsh` - One-shot commands
- `tool-bash-persistent` / `tool-pwsh-persistent` - Persistent sessions

### Filesystem Tools
- `tool-fs` - Read/write files
- `tool-fs-search` - Grep/glob search

### Subagent Tools
- `tool-subagent` - Spawn new agent
- `tool-subagent-fork` - Inherit context
- `tool-subagent-control` - Manage agents

### Workflow Tools
- `tool-workflow` - Execute workflows
- `tool-ralph` - Spec-driven agent loops

## Configuration Options

### Persona
```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a coding assistant.
    suffix: Your working directory is {{cwd}}.
```

### Web Tools
```yaml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    searchTimeoutMs: 60000
```

## Debugging

### Mount Validation
```
standingKeyFor('my-preset')
```

Returns success or specific error:
- `Cannot find package ...` - Missing dependency
- `invalid config: ...` - Bad configuration
- `N row(s) did not activate` - Missing service
- `row(s) published process-global service(s)` - Missing isolate realm

### Inspect Providers
```
cordis_inspect what:"services"
cordis_inspect what:"api" name:"agentPresets"
```
