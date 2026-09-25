/** Read-only compatibility scanner for local Claude Code and Codex plugins. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, realpathSync, statSync, type Dir, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Plugin manifest dialect recognized by the local scanner. */
export type PluginDialect = 'claude' | 'codex'
/** Severity assigned to an inventory diagnostic. */
export type DiagnosticSeverity = 'error' | 'warning'
/** Activation status assigned to an inventoried capability. */
export type CapabilityStatus = 'supported' | 'unsupported'

/** One validation or compatibility finding from a local scan. */
export interface PluginDiagnostic {
  readonly code: string
  readonly severity: DiagnosticSeverity
  readonly message: string
  readonly path?: string
}

/** Exact bytes and digest for one relevant local plugin source file. */
export interface PluginSourceFile {
  readonly path: string
  readonly sha256: string
  /** Source bytes decoded as UTF-8 for parsing. The digest retains the exact bytes. */
  readonly text: string
}

/** Supported or explicitly unsupported plugin contribution. */
export interface PluginCapability {
  readonly id: string
  readonly kind: 'skill' | 'mcp' | 'hook' | 'component'
  readonly status: CapabilityStatus
  readonly path?: string
  readonly reason?: string
}

/** Parsed skill document and its relative resource paths. */
export interface PluginSkill {
  readonly id: string
  readonly path: string
  readonly name?: string
  readonly description?: string
  readonly source: PluginSourceFile
  readonly resources: readonly string[]
  /** True when frontmatter changes execution semantics the Harness cannot preserve. */
  readonly unsupportedBehavior?: boolean
}

/** Validated MCP server configuration retained for activation. */
export interface PluginMcpServer {
  readonly id: string
  readonly name: string
  readonly config: unknown
  readonly sourcePath?: string
}

/** Validated command hook retained for activation. */
export interface PluginHook {
  readonly id: string
  readonly event: string
  readonly matcher?: string
  readonly command: string
  readonly timeoutSec?: number
  readonly sourcePath: string
}

/** Complete result of scanning one local plugin root. */
export interface PluginInventory {
  readonly id: string
  readonly dialect: PluginDialect
  readonly root: string
  readonly manifestPath?: string
  readonly manifest?: Readonly<Record<string, unknown>>
  readonly skills: readonly PluginSkill[]
  readonly mcpServers: readonly PluginMcpServer[]
  readonly hooks: readonly PluginHook[]
  readonly capabilities: readonly PluginCapability[]
  readonly diagnostics: readonly PluginDiagnostic[]
  readonly sources: readonly PluginSourceFile[]
  readonly fingerprint: string
  readonly valid: boolean
  readonly scanBounds?: Readonly<Pick<ScanPluginOptions, 'maxFiles' | 'maxFileBytes' | 'maxTotalBytes' | 'maxEntries'>>
}

/** Inputs and safety limits for a local plugin scan. */
export interface ScanPluginOptions {
  readonly root: string
  readonly dialect: PluginDialect
  /** Trusted activation path; it is only substituted into strings, never executed. */
  readonly pluginDataDir?: string
  readonly projectDir?: string
  readonly maxFiles?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
  /** Maximum number of directory entries inspected across the complete scan. */
  readonly maxEntries?: number
}

const CLAUDE_SUPPORTED_EVENTS = new Set([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop',
])
const CLAUDE_EVENTS = new Set([
  ...CLAUDE_SUPPORTED_EVENTS, 'Setup', 'UserPromptExpansion', 'PermissionRequest', 'PermissionDenied',
  'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay', 'TaskCreated', 'TaskCompleted',
  'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'DirectoryAdded',
  'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'PreCompact', 'PostCompact', 'PreModelSwitch',
  'PostModelSwitch', 'Elicitation', 'ElicitationResult', 'SessionEnd',
])
const CODEX_SUPPORTED_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop'])
const CODEX_EVENTS = new Set([
  ...CODEX_SUPPORTED_EVENTS, 'PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStop', 'Interrupt',
  'SubagentStart', 'SessionEnd',
])
const CLAUDE_FIELDS = new Set([
  '$schema', 'name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository', 'license',
  'keywords', 'metadata', 'defaultEnabled', 'skills', 'commands', 'agents', 'workflows', 'hooks', 'mcpServers',
  'outputStyles', 'lspServers', 'experimental', 'userConfig', 'channels', 'dependencies',
])
const CODEX_FIELDS = new Set(['name', 'displayName', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'metadata', 'interface', 'version', 'skills', 'hooks', 'mcpServers', 'apps'])

function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex')
}

interface ScanState {
  readonly root: string
  readonly options: ScanPluginOptions
  readonly diagnostics: PluginDiagnostic[]
  readonly files: Map<string, PluginSourceFile>
  entriesVisited: number
  traversalStopped: boolean
  totalBytes: number
}

function boundedSource(state: ScanState, path: string): PluginSourceFile | undefined {
  const existing = state.files.get(path)
  if (existing !== undefined) return existing
  const maxFiles = state.options.maxFiles ?? 256
  if (state.files.size >= maxFiles) {
    state.diagnostics.push({ code: 'scan-file-limit', severity: 'error', path, message: `plugin scan exceeds ${maxFiles} files` })
    return undefined
  }
  try {
    const realRoot = realpathSync(state.root)
    const realPath = realpathSync(path)
    if (!isContained(realRoot, realPath)) {
      state.diagnostics.push({ code: 'symlink-outside-root', severity: 'error', path, message: 'plugin source resolves through a symlink outside the plugin root' })
      return undefined
    }
    const initial = statSync(path)
    if (!initial.isFile()) throw new Error('not a regular file')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      // Compare the opened file with the inspected regular file; this is not an ancestor-mutation sandbox.
      if (!stat.isFile()) throw new Error('not a regular file')
      if (stat.dev !== initial.dev || stat.ino !== initial.ino) throw new Error('plugin source changed while opening')
      const maxFileBytes = state.options.maxFileBytes ?? 1_048_576
      const maxTotalBytes = state.options.maxTotalBytes ?? 8_388_608
      if (stat.size > maxFileBytes || state.totalBytes + stat.size > maxTotalBytes) {
        state.diagnostics.push({ code: 'scan-byte-limit', severity: 'error', path, message: 'plugin scan exceeds configured byte limits' })
        return undefined
      }
      const remaining = maxTotalBytes - state.totalBytes
      const limit = Math.min(maxFileBytes, remaining)
      const buffer = Buffer.alloc(limit + 1)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const read = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (read === 0) break
        bytesRead += read
      }
      if (bytesRead > limit) {
        state.diagnostics.push({ code: 'scan-byte-limit', severity: 'error', path, message: 'plugin source grew beyond configured byte limits while reading' })
        return undefined
      }
      const bytes = buffer.subarray(0, bytesRead)
      const text = bytes.toString('utf8')
      state.totalBytes += bytesRead
      const item = { path, sha256: sha256(bytes), text }
      state.files.set(path, item)
      return item
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    state.diagnostics.push({ code: 'unreadable-path', severity: 'error', path, message: String(error) })
    return undefined
  }
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function safePath(root: string, value: string, diagnostics: PluginDiagnostic[], path: string): string | undefined {
  if (!value.startsWith('./') && value !== '.') {
    diagnostics.push({ code: 'path-not-relative', severity: 'error', path, message: 'plugin paths must start with ./ and remain relative to the plugin root' })
    return undefined
  }
  const candidate = resolve(root, value)
  if (!isContained(root, candidate)) {
    diagnostics.push({ code: 'path-outside-root', severity: 'error', path, message: 'plugin path escapes the plugin root' })
    return undefined
  }
  try {
    const realRoot = realpathSync(root)
    const realCandidate = realpathSync(candidate)
    if (!isContained(realRoot, realCandidate)) {
      diagnostics.push({ code: 'symlink-outside-root', severity: 'error', path, message: 'plugin path resolves through a symlink outside the plugin root' })
      return undefined
    }
  } catch {
    diagnostics.push({ code: 'missing-path', severity: 'error', path, message: 'plugin path does not exist' })
    return undefined
  }
  return candidate
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function jsonFile(state: ScanState, path: string): { value?: unknown; source?: PluginSourceFile } {
  try {
    const raw = boundedSource(state, path)
    if (raw === undefined) return {}
    return { value: JSON.parse(raw.text), source: raw }
  } catch (error) {
    state.diagnostics.push({ code: 'invalid-json', severity: 'error', path, message: `invalid JSON: ${String(error)}` })
    return {}
  }
}

function substitute(value: unknown, vars: Readonly<Record<string, string | undefined>>): unknown {
  if (typeof value === 'string') return value.replace(/\$\{([A-Z_]+)\}/g, (all, key: string) => vars[key] ?? all)
  if (Array.isArray(value)) return value.map(item => substitute(item, vars))
  const record = object(value)
  if (record === undefined) return value
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, substitute(item, vars)]))
}

function addCapability(capabilities: PluginCapability[], ids: Set<string>, item: PluginCapability, diagnostics: PluginDiagnostic[]): void {
  if (ids.has(item.id)) diagnostics.push({ code: 'duplicate-capability-id', severity: 'error', message: `duplicate capability id ${item.id}` })
  ids.add(item.id)
  capabilities.push(item)
}

function addUnsupportedComponent(
  capabilities: PluginCapability[],
  ids: Set<string>,
  id: string,
  path: string,
  name: string,
  diagnostics: PluginDiagnostic[],
): void {
  addCapability(capabilities, ids, {
    id,
    kind: 'component',
    status: 'unsupported',
    path,
    reason: `${name} is not imported by the compatibility layer`,
  }, diagnostics)
}

function listFiles(state: ScanState, root: string): string[] {
  const { diagnostics, options } = state
  const files: string[] = []
  const discovered = new Set<string>()
  let totalBytes = 0
  const maxEntries = options.maxEntries ?? 4096
  const pending = [root]
  while (pending.length > 0 && !state.traversalStopped) {
    const dir = pending.pop() as string
    let handle: Dir
    try { handle = opendirSync(dir) } catch (error) {
      diagnostics.push({ code: 'unreadable-path', severity: 'error', path: dir, message: String(error) })
      continue
    }
    try {
      let entry: Dirent | null
      while (!state.traversalStopped && (entry = handle.readSync()) !== null) {
        state.entriesVisited += 1
        if (state.entriesVisited > maxEntries) {
          diagnostics.push({ code: 'scan-entry-limit', severity: 'error', path: join(dir, entry.name), message: `plugin scan exceeds ${maxEntries} directory entries` })
          state.traversalStopped = true
          break
        }
        const name = entry.name
        if (name === 'node_modules' || name === '.git') continue
        const path = join(dir, name)
        try {
          const stat = lstatSync(path)
          if (stat.isSymbolicLink()) {
            const resolved = realpathSync(path)
            if (!isContained(state.root, resolved)) diagnostics.push({ code: 'symlink-outside-root', severity: 'error', path, message: 'symlink resolves outside plugin root' })
            else diagnostics.push({ code: 'symlink-skipped', severity: 'warning', path, message: 'symlinked plugin content is not scanned' })
          } else if (stat.isDirectory()) pending.push(path)
          else if (stat.isFile()) {
            const maxFiles = options.maxFiles ?? 256
            const maxFileBytes = options.maxFileBytes ?? 1_048_576
            const maxTotalBytes = options.maxTotalBytes ?? 8_388_608
            const alreadyDiscovered = state.files.has(path) || discovered.has(path)
            if (!alreadyDiscovered) {
              if (state.files.size + discovered.size >= maxFiles) {
                diagnostics.push({ code: 'scan-file-limit', severity: 'error', path, message: `plugin scan exceeds ${maxFiles} files` })
                state.traversalStopped = true
                break
              }
              if (stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes) {
                diagnostics.push({ code: 'scan-byte-limit', severity: 'error', path, message: 'plugin scan exceeds configured byte limits' })
                state.traversalStopped = true
                break
              }
              discovered.add(path)
              totalBytes += stat.size
            }
            files.push(path)
          }
        } catch { diagnostics.push({ code: 'unreadable-path', severity: 'error', path, message: 'plugin path could not be inspected' }) }
      }
    } finally {
      handle.closeSync()
    }
  }
  return files.sort()
}

function parseSkill(path: string, state: ScanState): PluginSkill | undefined {
  const { diagnostics } = state
  try {
    const raw = boundedSource(state, path)
    if (raw === undefined) return undefined
    const dir = dirname(path)
    const resources = listFiles(state, dir).filter(file => file !== path)
    for (const resource of resources) boundedSource(state, resource)
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw.text)?.[1] ?? ''
    let metadata: Record<string, unknown> = {}
    try { metadata = object(parseYaml(front)) ?? {} } catch (error) {
      diagnostics.push({ code: 'invalid-skill-frontmatter', severity: 'error', path, message: String(error) })
    }
    let unsupportedBehavior = false
    for (const key of ['allowed-tools', 'context', 'agent', 'hooks', 'disable-model-invocation', 'user-invocable', 'model', 'argument-hint']) {
      if (metadata[key] !== undefined) {
        unsupportedBehavior = true
        diagnostics.push({ code: 'unsupported-skill-field', severity: 'warning', path, message: `skill field ${key} is not honored by the compatibility layer` })
      }
    }
    const name = typeof metadata.name === 'string' && metadata.name.trim() !== '' ? metadata.name.trim() : undefined
    const description = typeof metadata.description === 'string' && metadata.description.trim() !== '' ? metadata.description.trim() : undefined
    if (name === undefined) diagnostics.push({ code: 'missing-skill-name', severity: 'error', path, message: 'SKILL.md frontmatter requires a non-empty name' })
    if (description === undefined) diagnostics.push({ code: 'missing-skill-description', severity: 'error', path, message: 'SKILL.md frontmatter requires a non-empty description' })
    return {
      id: `skill:${name ?? basename(dir)}`,
      path,
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      source: raw,
      resources,
      ...(unsupportedBehavior ? { unsupportedBehavior: true } : {}),
    }
  } catch (error) {
    diagnostics.push({ code: 'invalid-skill', severity: 'error', path, message: String(error) })
    return undefined
  }
}

function parseMcp(
  value: unknown,
  state: ScanState,
  sourcePath: string,
  vars: Readonly<Record<string, string | undefined>>,
): PluginMcpServer[] {
  const { root, diagnostics } = state
  if (Array.isArray(value)) return value.flatMap((item, index) => parseMcp(item, state, `${sourcePath}[${index}]`, vars))
  let config = value
  if (typeof value === 'string') {
    const path = safePath(root, value, diagnostics, sourcePath)
    if (path === undefined) return []
    config = jsonFile(state, path).value
  }
  const record = object(config)
  const servers = object(record?.mcpServers) ?? object(record?.mcp_servers) ?? record
  if (servers === undefined) { diagnostics.push({ code: 'invalid-mcp', severity: 'error', path: sourcePath, message: 'MCP configuration must be an object or mcpServers wrapper' }); return [] }
  return Object.entries(servers).flatMap(([name, item]) => {
    const config = substitute(item, vars)
    const entry = object(config)
    if (entry === undefined) { diagnostics.push({ code: 'invalid-mcp-server', severity: 'error', path: sourcePath, message: `MCP server ${name} must be an object` }); return [] }
    const hasCommand = typeof entry.command === 'string' && entry.command.trim() !== ''
    const hasUrl = typeof entry.url === 'string' && entry.url.trim() !== ''
    if (hasCommand === hasUrl) { diagnostics.push({ code: 'unsupported-mcp-transport', severity: 'error', path: sourcePath, message: `MCP server ${name} must define exactly one stdio command or HTTP url` }); return [] }
    if (entry.type !== undefined && entry.type !== 'stdio' && entry.type !== 'http' && entry.type !== 'streamable-http') { diagnostics.push({ code: 'unsupported-mcp-transport', severity: 'error', path: sourcePath, message: `MCP server ${name} declares unsupported transport ${JSON.stringify(entry.type)}` }); return [] }
    if (entry.transport !== undefined && entry.transport !== 'stdio' && entry.transport !== 'http' && entry.transport !== 'streamable-http') { diagnostics.push({ code: 'unsupported-mcp-transport', severity: 'error', path: sourcePath, message: `MCP server ${name} declares unsupported transport ${JSON.stringify(entry.transport)}` }); return [] }
    if (entry.type !== undefined && entry.transport !== undefined && entry.type !== entry.transport) { diagnostics.push({ code: 'unsupported-mcp-transport', severity: 'error', path: sourcePath, message: `MCP server ${name} declares contradictory type and transport` }); return [] }
    const declaredTransport = entry.type ?? entry.transport
    const transportMatches = hasCommand ? declaredTransport === undefined || declaredTransport === 'stdio' : declaredTransport === undefined || declaredTransport === 'http' || declaredTransport === 'streamable-http'
    if (!transportMatches) { diagnostics.push({ code: 'unsupported-mcp-transport', severity: 'error', path: sourcePath, message: `MCP server ${name} transport does not match its command or url fields` }); return [] }
    if (entry.auth !== undefined || entry.oauth !== undefined) { diagnostics.push({ code: 'unsupported-mcp-auth', severity: 'error', path: sourcePath, message: `MCP server ${name} declares unsupported authentication` }); return [] }
    const allowed = hasCommand ? new Set(['command', 'args', 'env', 'cwd', 'transport', 'type']) : new Set(['url', 'headers', 'transport', 'type'])
    const unsupported = Object.keys(entry).filter(key => !allowed.has(key))
    if (unsupported.length > 0) { diagnostics.push({ code: 'unsupported-mcp-field', severity: 'error', path: sourcePath, message: `MCP server ${name} declares unsupported fields: ${unsupported.join(', ')}` }); return [] }
    if (hasUrl) {
      try {
        const url = new URL(entry.url as string)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL scheme must be http or https')
      } catch (error) {
        diagnostics.push({ code: 'invalid-mcp-url', severity: 'error', path: sourcePath, message: `MCP server ${name} url is invalid: ${String(error)}` })
        return []
      }
    }
    if (hasCommand && entry.cwd !== undefined && (typeof entry.cwd !== 'string' || entry.cwd.trim() === '')) { diagnostics.push({ code: 'invalid-mcp-cwd', severity: 'error', path: sourcePath, message: `MCP server ${name} cwd must be a non-empty string` }); return [] }
    if (hasCommand && entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string'))) { diagnostics.push({ code: 'invalid-mcp-args', severity: 'error', path: sourcePath, message: `MCP server ${name} args must be an array of strings` }); return [] }
    for (const key of ['env', 'headers']) {
      const value = entry[key]
      if (value !== undefined && (object(value) === undefined || Object.values(value as Record<string, unknown>).some(item => typeof item !== 'string'))) { diagnostics.push({ code: 'invalid-mcp-fields', severity: 'error', path: sourcePath, message: `MCP server ${name} ${key} must be a string map` }); return [] }
    }
    return [{ id: `mcp:${name}`, name, config, sourcePath }]
  })
}

function parseHooks(
  value: unknown,
  state: ScanState,
  sourcePath: string,
  dialect: PluginDialect,
  vars: Readonly<Record<string, string | undefined>>,
): PluginHook[] {
  const { root, diagnostics } = state
  if (Array.isArray(value)) return value.flatMap((item, index) => parseHooks(item, state, `${sourcePath}[${index}]`, dialect, vars))
  if (typeof value === 'string') {
    const path = safePath(root, value, diagnostics, sourcePath)
    if (path === undefined) return []
    const loaded = jsonFile(state, path)
    return loaded.value === undefined ? [] : parseHooks(loaded.value, state, path, dialect, vars)
  }
  const record = object(value)
  const hooksMap = object(record?.hooks) ?? record
  if (hooksMap === undefined) { diagnostics.push({ code: 'invalid-hooks', severity: 'error', path: sourcePath, message: 'hooks configuration must be an object' }); return [] }
  const known = dialect === 'claude' ? CLAUDE_EVENTS : CODEX_EVENTS
  const supported = dialect === 'claude' ? CLAUDE_SUPPORTED_EVENTS : CODEX_SUPPORTED_EVENTS
  const hooks: PluginHook[] = []
  for (const [event, groups] of Object.entries(hooksMap)) {
    if (!known.has(event)) { diagnostics.push({ code: 'unsupported-hook-event', severity: 'warning', path: sourcePath, message: `unsupported hook event ${event}` }); continue }
    if (!supported.has(event)) { diagnostics.push({ code: 'unsupported-hook-event', severity: 'warning', path: sourcePath, message: `known but unsupported hook event ${event}` }); continue }
    if (!Array.isArray(groups)) { diagnostics.push({ code: 'invalid-hook-groups', severity: 'error', path: sourcePath, message: `hook event ${event} must be an array` }); continue }
    groups.forEach((rawGroup, groupIndex) => {
      const group = object(rawGroup)
      if (group === undefined || !Array.isArray(group.hooks)) { diagnostics.push({ code: 'invalid-hook-group', severity: 'error', path: sourcePath, message: `invalid matcher group ${event}[${groupIndex}]` }); return }
      group.hooks.forEach((rawHook, hookIndex) => {
        const hook = object(rawHook)
        if (hook === undefined) { diagnostics.push({ code: 'invalid-hook', severity: 'error', path: sourcePath, message: `hook at ${event}[${groupIndex}][${hookIndex}] must be an object` }); return }
        if (hook.type !== undefined && typeof hook.type !== 'string') { diagnostics.push({ code: 'invalid-hook-type', severity: 'error', path: sourcePath, message: `hook type at ${event}[${groupIndex}][${hookIndex}] must be a string` }); return }
        const type = typeof hook.type === 'string' ? hook.type : 'command'
        if (type !== 'command') { diagnostics.push({ code: 'unsupported-hook-type', severity: 'warning', path: sourcePath, message: `unsupported ${type} hook at ${event}[${groupIndex}][${hookIndex}]` }); return }
        if (hook.async !== undefined && typeof hook.async !== 'boolean') { diagnostics.push({ code: 'invalid-hook-async', severity: 'error', path: sourcePath, message: `async at ${event}[${groupIndex}][${hookIndex}] must be boolean` }); return }
        if (hook.async === true) { diagnostics.push({ code: 'unsupported-async-hook', severity: 'warning', path: sourcePath, message: `async hook at ${event}[${groupIndex}][${hookIndex}] is disabled` }); return }
        if (typeof hook.command !== 'string' || hook.command.trim() === '') { diagnostics.push({ code: 'invalid-hook-command', severity: 'error', path: sourcePath, message: `command hook at ${event}[${groupIndex}][${hookIndex}] has no command` }); return }
        const timeoutValue = hook.timeout ?? hook.timeoutSec
        if (timeoutValue !== undefined && (typeof timeoutValue !== 'number' || !Number.isFinite(timeoutValue) || timeoutValue < 0)) { diagnostics.push({ code: 'invalid-hook-timeout', severity: 'error', path: sourcePath, message: `timeout at ${event}[${groupIndex}][${hookIndex}] must be a finite non-negative number` }); return }
        if (group.matcher !== undefined && typeof group.matcher !== 'string') { diagnostics.push({ code: 'invalid-hook-matcher', severity: 'error', path: sourcePath, message: `matcher at ${event}[${groupIndex}] must be a string` }); return }
        const timeout = typeof timeoutValue === 'number' ? timeoutValue : undefined
        hooks.push({ id: `hook:${event}:${groupIndex}:${hookIndex}`, event, ...(typeof group.matcher === 'string' ? { matcher: group.matcher } : {}), command: substitute(hook.command, vars) as string, ...(timeout === undefined ? {} : { timeoutSec: timeout }), sourcePath })
      })
    })
  }
  return hooks
}

/** Scan one already-present local plugin directory without executing any content.
 * @param options - root, dialect, trusted substitutions, and scan bounds.
 * @returns a complete supported and unsupported component inventory.
 */
export function scanPluginRoot(options: ScanPluginOptions): PluginInventory {
  const root = (() => {
    try { return realpathSync(resolve(options.root)) } catch { return resolve(options.root) }
  })()
  const diagnostics: PluginDiagnostic[] = []
  const bounds = {
    maxFiles: options.maxFiles,
    maxFileBytes: options.maxFileBytes,
    maxTotalBytes: options.maxTotalBytes,
    maxEntries: options.maxEntries,
  }
  for (const [key, value] of Object.entries(bounds)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) diagnostics.push({ code: 'invalid-scan-bounds', severity: 'error', path: root, message: `${key} must be a positive safe integer` })
  }
  const state: ScanState = { root, options, diagnostics, files: new Map(), entriesVisited: 0, traversalStopped: false, totalBytes: 0 }
  const capabilities: PluginCapability[] = []
  const ids = new Set<string>()
  try {
    if (!lstatSync(root).isDirectory()) diagnostics.push({ code: 'invalid-root', severity: 'error', path: root, message: 'plugin root must be a directory' })
  } catch { diagnostics.push({ code: 'missing-root', severity: 'error', path: root, message: 'plugin root does not exist' }) }
  const vars = {
    CLAUDE_PLUGIN_ROOT: root, PLUGIN_ROOT: root,
    ...(options.pluginDataDir === undefined ? {} : {
      CLAUDE_PLUGIN_DATA: resolve(options.pluginDataDir),
      PLUGIN_DATA: resolve(options.pluginDataDir),
    }),
    ...(options.projectDir === undefined ? {} : { CLAUDE_PROJECT_DIR: resolve(options.projectDir) }),
  }
  let manifestPath: string | undefined
  const candidate = join(root, options.dialect === 'claude' ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json')
  try {
    realpathSync(candidate)
    const checked = safePath(root, `./${relative(root, candidate)}`, diagnostics, 'manifest')
    if (checked !== undefined) manifestPath = checked
  } catch { /* manifest is handled as missing below */ }
  const manifestResult = manifestPath === undefined ? {} : jsonFile(state, manifestPath)
  const manifest = object(manifestResult.value)
  const hasClaudeDefaults = (() => {
    for (const candidate of ['skills', 'hooks/hooks.json', '.mcp.json']) {
      try { realpathSync(join(root, candidate)); return true } catch { /* continue */ }
    }
    return false
  })()
  if (manifestPath === undefined && (options.dialect === 'codex' || !hasClaudeDefaults)) diagnostics.push({ code: 'missing-manifest', severity: 'error', path: root, message: 'plugin manifest is required for this plugin layout' })
  else if (manifestPath !== undefined && manifest === undefined) diagnostics.push({ code: 'invalid-manifest', severity: 'error', path: manifestPath, message: 'plugin manifest must be a JSON object' })
  const fields = options.dialect === 'claude' ? CLAUDE_FIELDS : CODEX_FIELDS
  if (manifest !== undefined) {
    if (typeof manifest.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) diagnostics.push({ code: 'invalid-name', severity: 'error', path: candidate, message: 'manifest name must be kebab-case' })
    for (const key of Object.keys(manifest)) if (!fields.has(key)) diagnostics.push({ code: 'unknown-manifest-field', severity: 'warning', path: candidate, message: `unrecognized manifest field ${key}` })
  }
  const skillPaths: string[] = []
  const skillsValue = manifest?.skills
  const defaultSkills = join(root, 'skills')
  const hasDefaultSkills = (() => { try { return lstatSync(defaultSkills).isDirectory() } catch { return false } })()
  const customSkillEntries: readonly unknown[] = skillsValue === undefined
    ? []
    : Array.isArray(skillsValue) ? skillsValue as readonly unknown[] : [skillsValue]
  const skillEntries = [...(hasDefaultSkills ? ['./skills/'] : []), ...customSkillEntries]
  for (const value of skillEntries) {
    if (typeof value !== 'string') { diagnostics.push({ code: 'invalid-skill-path', severity: 'error', path: candidate, message: 'skills must contain paths' }); continue }
    const dir = safePath(root, value, diagnostics, manifestPath ?? 'skills')
    if (dir === undefined) continue
    for (const file of listFiles(state, dir)) if (file.endsWith(`${sep}SKILL.md`)) skillPaths.push(file)
  }
  const skills = [...new Map(skillPaths.map(path => [path, parseSkill(path, state)] as const)
    .filter((entry): entry is [string, PluginSkill] => entry[1] !== undefined)).values()]
  for (const skill of skills) addCapability(capabilities, ids, {
    id: skill.id,
    kind: 'skill',
    status: skill.unsupportedBehavior === true ? 'unsupported' : 'supported',
    path: skill.path,
    ...(skill.unsupportedBehavior === true ? { reason: 'skill frontmatter declares unsupported execution behavior' } : {}),
  }, diagnostics)
  const mcpServers: PluginMcpServer[] = []
  const mcpValue = manifest?.mcpServers ?? (() => { const path = join(root, '.mcp.json'); try { realpathSync(path); const checked = safePath(root, './.mcp.json', diagnostics, '.mcp.json'); return checked === undefined ? undefined : jsonFile(state, checked).value } catch {} return undefined })()
  if (mcpValue !== undefined) mcpServers.push(...parseMcp(mcpValue, state, manifestPath ?? '.mcp.json', vars))
  for (const server of mcpServers) addCapability(capabilities, ids, { id: server.id, kind: 'mcp', status: 'supported' }, diagnostics)
  const hooks: PluginHook[] = []
  const hooksValue = manifest?.hooks ?? (() => { const path = join(root, 'hooks/hooks.json'); try { realpathSync(path); const checked = safePath(root, './hooks/hooks.json', diagnostics, 'hooks/hooks.json'); return checked === undefined ? undefined : jsonFile(state, checked).value } catch {} return undefined })()
  if (hooksValue !== undefined) hooks.push(...parseHooks(hooksValue, state, manifestPath ?? 'hooks/hooks.json', options.dialect, vars))
  for (const hook of hooks) addCapability(capabilities, ids, { id: hook.id, kind: 'hook', status: 'supported', path: hook.sourcePath }, diagnostics)
  for (const [key, kind] of [['agents', 'component'], ['commands', 'component'], ['lspServers', 'component'], ['apps', 'component'], ['workflows', 'component'], ['outputStyles', 'component'], ['channels', 'component'], ['dependencies', 'component'], ['userConfig', 'component'], ['defaultEnabled', 'component'], ['experimental', 'component']] as const) {
    if (manifest?.[key] !== undefined) {
      addUnsupportedComponent(capabilities, ids, `${kind}:${key}`, candidate, key, diagnostics)
      diagnostics.push({ code: 'unsupported-component', severity: 'warning', path: candidate, message: `manifest declares unsupported ${key}` })
    }
  }
  for (const [name, id] of [['agents', 'component:agents'], ['commands', 'component:commands'], ['.lsp.json', 'component:lspServers'], ['.app.json', 'component:apps']] as const) {
    const path = join(root, name)
    try {
      if (lstatSync(path).isDirectory() || lstatSync(path).isFile()) {
        addUnsupportedComponent(capabilities, ids, id, path, name, diagnostics)
        diagnostics.push({ code: 'unsupported-component', severity: 'warning', path, message: `${name} is present but unsupported` })
      }
    } catch { /* absent */ }
  }
  const sources = [...state.files.values()].sort((a, b) => a.path.localeCompare(b.path))
  const fingerprint = sha256(sources.map(item => `${relative(root, item.path)}\0${item.sha256}`).join('\n'))
  const id = typeof manifest?.name === 'string' ? `${options.dialect}:${manifest.name}` : `${options.dialect}:${root}`
  const scanBounds = Object.fromEntries(Object.entries({ maxFiles: options.maxFiles, maxFileBytes: options.maxFileBytes, maxTotalBytes: options.maxTotalBytes, maxEntries: options.maxEntries }).filter((entry): entry is [string, number] => entry[1] !== undefined)) as Pick<ScanPluginOptions, 'maxFiles' | 'maxFileBytes' | 'maxTotalBytes' | 'maxEntries'>
  return { id, dialect: options.dialect, root, ...(manifestPath === undefined ? {} : { manifestPath }), ...(manifest === undefined ? {} : { manifest }), skills, mcpServers, hooks, capabilities, diagnostics, sources, fingerprint, valid: !diagnostics.some(item => item.severity === 'error'), ...(Object.keys(scanBounds).length === 0 ? {} : { scanBounds }) }
}

/** Recompute the file-boundary fingerprint before activating an imported plugin.
 * @param inventory - the prior scan record.
 * @returns the current fingerprint of its relevant source files.
 */
export function pluginFingerprint(inventory: PluginInventory): string {
  return scanPluginRoot({ root: inventory.root, dialect: inventory.dialect, ...inventory.scanBounds }).fingerprint
}

/** Return whether the previously scanned source bytes are still unchanged.
 * @param inventory - the prior scan record.
 * @returns true when every relevant source file has the recorded bytes.
 */
export function isPluginUnchanged(inventory: PluginInventory): boolean {
  return pluginFingerprint(inventory) === inventory.fingerprint
}

/** Inspect a local plugin, detecting its manifest dialect when one is present.
 * @param root - local plugin directory.
 * @param options - optional dialect override, substitutions, and scan bounds.
 * @returns a complete compatibility inventory.
 */
export function inspectLocalPlugin(root: string, options: Omit<ScanPluginOptions, 'root' | 'dialect'> & { dialect?: PluginDialect } = {}): PluginInventory {
  let dialect = options.dialect
  if (dialect === undefined) {
    let claude = false
    let codex = false
    try { claude = lstatSync(join(root, '.claude-plugin/plugin.json')).isFile() } catch { /* absent */ }
    try { codex = lstatSync(join(root, '.codex-plugin/plugin.json')).isFile() } catch { /* absent */ }
    if (claude && codex) {
      const inventory = scanPluginRoot({ root, dialect: 'claude', ...options })
      return { ...inventory, valid: false, diagnostics: [...inventory.diagnostics, { code: 'ambiguous-dialect', severity: 'error', path: root, message: 'both Claude and Codex manifests are present' }] }
    }
    if (claude || codex) dialect = claude ? 'claude' : 'codex'
    else {
      try {
        realpathSync(join(root, 'skills'))
        dialect = 'claude'
      } catch {
        try { realpathSync(join(root, 'hooks/hooks.json')); dialect = 'claude' } catch {
          try { realpathSync(join(root, '.mcp.json')); dialect = 'claude' } catch { dialect = 'codex' }
        }
      }
    }
  }
  return scanPluginRoot({ root, dialect, ...options })
}
