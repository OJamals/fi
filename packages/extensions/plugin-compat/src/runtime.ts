/** Mount resolved Claude and Codex compatibility contributions on one agent. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-skill'
import { apply as applyClaudeHooks, Config as ClaudeHooksConfig, inject as claudeHookInject } from '@deepseek-ai/dsh-hooks-claude-code'
import { apply as applyCodexHooks, Config as CodexHooksConfig, inject as codexHookInject } from '@deepseek-ai/dsh-hooks-codex'
import { apply as applyMcpClient, Config as McpClientConfig, inject as mcpClientInject, type Config as McpClientConfigValue } from '@deepseek-ai/dsh-mcp-client'
import type { ManagedPluginItemId } from './types.ts'
import type { PluginHook, PluginInventory, PluginMcpServer, PluginSkill } from './manifest.ts'
import type { ResolvedManagedPlugin } from './index.ts'

/** Services the scoped skill contribution requires from its prepared Agent. */
const skillInject = ['skills']

/**
 * Mount each enabled, scanner-supported contribution in `resolved` on `agent`.
 * Child plugin readiness is awaited so `agent/created` rejects before publication.
 * @param agent - prepared agent whose scoped context owns every contribution.
 * @param resolved - global and workspace-local plugins selected for this agent.
 * @param signal - creation-time cancellation. An MCP server's connection attempt has no
 *   natural completion deadline of its own, so it is the one mount awaited here that must
 *   react to it directly; a disposed-while-pending Fiber settles its own `await()`, and
 *   `throwIfAborted()` then reports the caller's exact reason instead of that settlement.
 * @returns fulfillment after all selected child plugins have become ready.
 */
export async function mountManagedPlugins(
  agent: Agent,
  resolved: readonly ResolvedManagedPlugin[],
  signal?: AbortSignal,
): Promise<void> {
  for (const plugin of resolved) {
    if (!plugin.enabled) continue
    await mountSkills(agent, plugin)
    for (const server of plugin.inventory.mcpServers) {
      if (!selected(plugin, server.id) || !supported(plugin.inventory, server.id)) continue
      requireServices(agent, plugin, 'MCP server', server.id, server.name, mcpClientInject)
      await mountCancelable(agent.ctx.plugin({
        name: `managed-mcp-${token(plugin, server.id)}`,
        Config: McpClientConfig,
        inject: mcpClientInject,
        apply: applyMcpClient,
      }, mcpConfig(plugin, server)), signal)
    }
    const hooks = plugin.inventory.hooks.filter(hook => selected(plugin, hook.id) && supported(plugin.inventory, hook.id))
    if (hooks.length > 0) await mountHooks(agent, plugin, hooks)
  }
}

/** A started Cordis Fiber, narrowed to the two operations {@link mountCancelable} needs. */
interface CancelableFiber {
  await(): Promise<unknown>
  dispose(): Promise<void>
}

/**
 * Await one child plugin's activation, disposing it as soon as `signal` aborts so a still-
 * connecting process is never left running past the creation it was rejected under.
 * @param fiber - the Fiber returned by mounting the child plugin.
 * @param signal - creation-time cancellation; omitted when the caller applies none.
 * @returns fulfillment once the fiber activates, before `signal` next aborts.
 * @throws `signal`'s abort reason once it has fired, in place of whatever error disposing
 *   mid-activation left the fiber's own `await()` settled with.
 */
async function mountCancelable(fiber: CancelableFiber, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) { await fiber.await(); return }
  signal.throwIfAborted()
  const onAbort = (): void => { void fiber.dispose() }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await fiber.await()
    signal.throwIfAborted()
  } catch (error) {
    signal.throwIfAborted()
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

async function mountSkills(agent: Agent, plugin: ResolvedManagedPlugin): Promise<void> {
  const skills = plugin.inventory.skills.filter(skill => selected(plugin, skill.id) && supported(plugin.inventory, skill.id))
  if (skills.length === 0) return
  for (const skill of skills) {
    requireServices(agent, plugin, 'skill', skill.id, skill.name ?? skill.id, skillInject)
  }
  await agent.ctx.plugin({
    name: `managed-skills-${token(plugin, 'skills')}`,
    inject: skillInject,
    apply(ctx: Context) {
      for (const skill of skills) registerSkill(ctx, plugin, skill)
    },
  }).await()
}

function registerSkill(ctx: Context, plugin: ResolvedManagedPlugin, skill: PluginSkill): void {
  ctx.skills.register({
    name: skillAlias(plugin, skill),
    description: skill.description ?? 'Imported compatibility plugin skill',
    source: plugin.inventory.dialect === 'claude' ? 'claude-plugin' : 'codex-plugin',
    content: skillBody(skill),
    path: skill.path,
    resourceBase: { kind: 'directory', path: dirname(skill.path) },
    metadata: {
      dialect: plugin.inventory.dialect,
      managedPluginId: plugin.pluginId,
      originalName: skill.name ?? skill.id,
    },
  })
}

async function mountHooks(agent: Agent, plugin: ResolvedManagedPlugin, hooks: readonly PluginHook[]): Promise<void> {
  const inject = plugin.inventory.dialect === 'claude' ? claudeHookInject : codexHookInject
  for (const hook of hooks) {
    requireServices(agent, plugin, 'hook', hook.id, hook.event, inject)
  }
  let directory!: string
  await agent.ctx.effect(async function* () {
    directory = await mkdtemp(join(tmpdir(), `dsh-managed-hooks-${token(plugin, 'hooks')}-`))
    yield async () => { await rm(directory, { recursive: true, force: true }) }
    await writeFile(join(directory, 'hooks.json'), JSON.stringify({ hooks: hookConfig(hooks) }), { encoding: 'utf8', mode: 0o600 })
  }, `managed-hooks-cleanup(${plugin.pluginId})`)
  const configPath = join(directory, 'hooks.json')
  if (plugin.inventory.dialect === 'claude') {
    await agent.ctx.plugin({
      name: `managed-claude-hooks-${token(plugin, 'hooks')}`,
      Config: ClaudeHooksConfig,
      inject: claudeHookInject,
      apply: applyClaudeHooks,
    }, {
      configPath,
      pluginRoot: plugin.root,
      ...agent.session.header.cwd === undefined ? {} : { projectDir: agent.session.header.cwd },
    }).await()
    return
  }
  await agent.ctx.plugin({
    name: `managed-codex-hooks-${token(plugin, 'hooks')}`,
    Config: CodexHooksConfig,
    inject: codexHookInject,
    apply: applyCodexHooks,
  }, { configPath }).await()
}

/**
 * Reject an enabled component before Cordis creates a child plugin that would
 * remain pending while it waits for an unavailable service.
 * @param agent - prepared Agent providing the scoped service lookup.
 * @param plugin - imported plugin that owns the selected component.
 * @param kind - human-readable selected component kind.
 * @param id - stable inventory item identifier.
 * @param name - scanner-provided component name for diagnostics.
 * @param inject - services declared by the native implementation.
 * @returns nothing when all declared services are available.
 * @throws when the Agent scope lacks a declared service.
 */
function requireServices(
  agent: Agent,
  plugin: ResolvedManagedPlugin,
  kind: string,
  id: string,
  name: string,
  inject: readonly string[],
): void {
  const missing = inject.filter(service => agent.ctx.get(service) === undefined)
  if (missing.length === 0) return
  throw new Error(
    `managed plugin "${plugin.pluginId}" ${kind} "${name}" (${id}) cannot activate: `
    + `missing required services ${missing.join(', ')}`,
  )
}

function mcpConfig(plugin: ResolvedManagedPlugin, server: PluginMcpServer): McpClientConfigValue {
  const config = object(server.config)
  if (typeof config.command === 'string') {
    return McpClientConfig({
      transport: 'stdio',
      serverName: `pc_${token(plugin, server.id)}`,
      command: config.command,
      args: strings(config.args),
      env: stringMap(config.env),
      cwd: typeof config.cwd === 'string' ? config.cwd : plugin.root,
      failOnStartupError: true,
    })
  }
  if (typeof config.url !== 'string') throw new Error(`managed MCP server "${server.name}" has no supported transport`)
  return McpClientConfig({
    transport: 'streamable-http',
    serverName: `pc_${token(plugin, server.id)}`,
    url: config.url,
    headers: stringMap(config.headers),
    failOnStartupError: true,
  })
}

function hookConfig(hooks: readonly PluginHook[]): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {}
  for (const hook of hooks) {
    const group = {
      ...hook.matcher === undefined ? {} : { matcher: hook.matcher },
      hooks: [{
        type: 'command',
        command: hook.command,
        ...hook.timeoutSec === undefined ? {} : { timeout: hook.timeoutSec },
      }],
    }
    ;(result[hook.event] ??= []).push(group)
  }
  return result
}

function selected(plugin: ResolvedManagedPlugin, id: string): boolean {
  return plugin.enabledItemIds.has(id as ManagedPluginItemId)
}

function supported(inventory: PluginInventory, id: string): boolean {
  return inventory.capabilities.some(capability => capability.id === id && capability.status === 'supported')
}

function token(plugin: ResolvedManagedPlugin, itemId: string): string {
  return createHash('sha256').update(`${pluginIdentity(plugin)}\0${itemId}`).digest('hex').slice(0, 20)
}

function skillAlias(plugin: ResolvedManagedPlugin, skill: PluginSkill): string {
  const declaredName = plugin.inventory.manifest?.name
  const pluginName = normalizeSkillSegment(typeof declaredName === 'string' ? declaredName : basename(plugin.root))
  const skillName = normalizeSkillSegment(skill.name ?? skill.id)
  return `managed-${pluginName}-${skillName}-${token(plugin, skill.id).slice(0, 8)}`
}

function pluginIdentity(plugin: ResolvedManagedPlugin): string {
  return plugin.inventory.id
}

function normalizeSkillSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized === '' ? 'plugin' : normalized
}

function skillBody(skill: PluginSkill): string {
  return skill.source.text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim()
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('managed MCP configuration is invalid')
  return value as Readonly<Record<string, unknown>>
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : []
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
