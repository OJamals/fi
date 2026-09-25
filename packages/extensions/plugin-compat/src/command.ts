/**
 * Human-facing `/plugin-*` commands over the global {@link PluginCompatService}
 * plane. This is the only shipped consent surface for importing a local Claude
 * or Codex plugin: every mutation is a command a person typed, never an
 * automatic action taken on discovery. Workspace-scoped selection remains a
 * programmatic {@link PluginCompatService} capability that a future settings
 * surface can drive directly; these commands only ever pass `{ kind: 'global' }`.
 * @module @deepseek-ai/dsh-plugin-compat/command
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { ManagedPlugin, ManagedPluginId, ManagedPluginItemId, ManagedPluginItemKind, ManagedPluginScope, WorkspacePathResolver } from './index.ts'

export const name = 'plugin-compat-command'
export const inject = ['commands', 'pluginCompat']

const GLOBAL: ManagedPluginScope = { kind: 'global' }
/** Global-scope mutations never resolve a workspace path. */
const NO_WORKSPACE: WorkspacePathResolver = () => undefined
const MAX_REVISION_RETRIES = 3

function asPluginId(text: string): ManagedPluginId {
  return text as ManagedPluginId
}
function asItemId(text: string): ManagedPluginItemId {
  return text as ManagedPluginItemId
}

function usageError(usage: string): CommandResult {
  return { kind: 'error', text: `Usage: ${usage}` }
}

/**
 * Re-fetch the current revision and retry a mutation a bounded number of
 * times when a concurrent command wins the optimistic-concurrency fence.
 * @param ctx - context carrying `ctx.pluginCompat`.
 * @param mutate - the mutation, given the just-read current revision.
 * @returns the settled mutation result.
 */
async function withCurrentRevision<T>(
  ctx: Context,
  mutate: (revision: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const snapshot = await ctx.pluginCompat.list(GLOBAL, NO_WORKSPACE)
    try {
      return await mutate(snapshot.revision)
    } catch (error) {
      const conflict = error instanceof Error && error.message.includes('revision conflict')
      if (!conflict || attempt >= MAX_REVISION_RETRIES) throw error
    }
  }
}

function renderPlugin(plugin: ManagedPlugin): string {
  const header = `${plugin.enabled ? '[on] ' : '[off]'} ${plugin.id}  ${plugin.origin}  ${plugin.name}  (${plugin.path})`
  const items = plugin.items.map(item => `    ${item.enabled ? '[on] ' : '[off]'} ${item.kind}:${item.id}  ${item.name}`)
  const diagnostics = plugin.diagnostics.map(diagnostic => `    ! ${diagnostic.message}`)
  return [header, ...items, ...diagnostics].join('\n')
}

async function executeList(ctx: Context): Promise<CommandResult> {
  const snapshot = await ctx.pluginCompat.list(GLOBAL, NO_WORKSPACE)
  if (snapshot.plugins.length === 0) {
    return { kind: 'success', text: 'No imported Claude or Codex plugins. Use /plugin-import <path> to import one.' }
  }
  const text = [
    `Imported plugins (revision ${snapshot.revision}). MCP and hook items start disabled and run local commands or reach a network server once enabled — enable only sources you trust.`,
    ...snapshot.plugins.map(renderPlugin),
  ].join('\n')
  return { kind: 'success', text }
}

async function executeImport(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const path = invocation.rawInput.trim()
  if (path.length === 0) return usageError('/plugin-import <local plugin directory>')
  try {
    const mutation = await withCurrentRevision(ctx, revision => ctx.pluginCompat.importLocal(GLOBAL, path, revision, NO_WORKSPACE))
    const added = mutation.snapshot.plugins.at(-1)
    return {
      kind: 'success',
      text: added === undefined
        ? 'Plugin imported.'
        : `Imported "${added.name}" (${added.origin}) as ${added.id}. Skills are enabled; MCP servers and hooks are disabled until you run /plugin-enable. Run /plugin-list to review it, including any unsupported-component warnings.`,
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

async function executeRemove(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const id = invocation.rawInput.trim()
  if (id.length === 0) return usageError('/plugin-remove <plugin id>')
  try {
    await withCurrentRevision(ctx, revision => ctx.pluginCompat.remove(GLOBAL, asPluginId(id), revision, NO_WORKSPACE))
    return { kind: 'success', text: `Removed plugin ${id}. It stays mounted in already-composed sessions until a new one is started.` }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** Parse `<pluginId>` or `<pluginId> <kind>:<itemId>` into a set-enabled target. */
function parseTarget(rawInput: string):
  | { pluginId: ManagedPluginId; kind: 'plugin' }
  | { pluginId: ManagedPluginId; kind: ManagedPluginItemKind; itemId: ManagedPluginItemId }
  | undefined {
  const parts = rawInput.trim().split(/\s+/u).filter(part => part.length > 0)
  if (parts.length === 1) return { pluginId: asPluginId(parts[0] as string), kind: 'plugin' }
  if (parts.length === 2) {
    const [pluginId, item] = parts as [string, string]
    const separator = item.indexOf(':')
    if (separator < 0) return undefined
    const kind = item.slice(0, separator)
    const itemId = item.slice(separator + 1)
    if (kind !== 'skill' && kind !== 'mcp' && kind !== 'hook') return undefined
    if (itemId.length === 0) return undefined
    return { pluginId: asPluginId(pluginId), kind, itemId: asItemId(itemId) }
  }
  return undefined
}

function executeSetEnabled(ctx: Context, invocation: CommandInvocation, enabled: boolean): Promise<CommandResult> {
  const usage = `/plugin-${enabled ? 'enable' : 'disable'} <plugin id> [skill|mcp|hook:<item id>]`
  const target = parseTarget(invocation.rawInput)
  if (target === undefined) return Promise.resolve(usageError(usage))
  return withCurrentRevision(ctx, revision => ctx.pluginCompat.setEnabled(GLOBAL, target, enabled, revision, NO_WORKSPACE))
    .then((mutation): CommandResult => ({
      kind: 'success',
      text: `${enabled ? 'Enabled' : 'Disabled'} ${target.kind === 'plugin' ? target.pluginId : `${target.kind}:${target.itemId}`}. Revision is now ${mutation.snapshot.revision}; the change applies to sessions composed from now on.`,
    }))
    .catch((error: unknown): CommandResult => ({ kind: 'error', text: error instanceof Error ? error.message : String(error) }))
}

/**
 * Register the `/plugin-import`, `/plugin-list`, `/plugin-enable`,
 * `/plugin-disable`, and `/plugin-remove` global-scope commands.
 * @param ctx - context carrying the command registry and `ctx.pluginCompat`.
 */
export function apply(ctx: Context): void {
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-plugin-compat/import'),
      name: 'plugin-import',
      description: 'Import a local Claude or Codex plugin directory (read-only scan; nothing is executed)',
      input: { hint: 'local plugin directory' },
      handler: invocation => executeImport(ctx, invocation),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-plugin-compat/list'),
      name: 'plugin-list',
      description: 'List imported Claude and Codex plugins and their enabled components',
      recordInput: false,
      handler: () => executeList(ctx),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-plugin-compat/enable'),
      name: 'plugin-enable',
      description: 'Enable an imported plugin, or one of its skill/mcp/hook items',
      input: { hint: 'plugin id [skill|mcp|hook:item id]' },
      handler: invocation => executeSetEnabled(ctx, invocation, true),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-plugin-compat/disable'),
      name: 'plugin-disable',
      description: 'Disable an imported plugin, or one of its skill/mcp/hook items',
      input: { hint: 'plugin id [skill|mcp|hook:item id]' },
      handler: invocation => executeSetEnabled(ctx, invocation, false),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-plugin-compat/remove'),
      name: 'plugin-remove',
      description: 'Remove an imported Claude or Codex plugin association',
      input: { hint: 'plugin id' },
      handler: invocation => executeRemove(ctx, invocation),
    })
  }, 'plugin-compat-command registration')
}
