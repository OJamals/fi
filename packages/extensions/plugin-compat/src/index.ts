/** Scoped persistent compatibility-plugin registry. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import schema from '@deepseek-ai/schemastery'
import z from 'zod'
import { inspectLocalPlugin, scanPluginRoot, type PluginInventory } from './manifest.ts'
import { mountManagedPlugins } from './runtime.ts'
import type { ManagedPlugin, ManagedPluginId, ManagedPluginItemId, ManagedPluginMutation, ManagedPluginOverrideTarget, ManagedPluginScope, ManagedPluginSnapshot } from './types.ts'
export type * from './types.ts'
export { mountManagedPlugins } from './runtime.ts'

const diagnostic = z.object({
  code: z.enum(['unsupported-component', 'unsupported-hook', 'invalid-configuration', 'activation-failed']),
  message: z.string(),
}).strict()
const item = z.object({
  id: z.string().min(1),
  kind: z.enum(['skill', 'mcp', 'hook']),
  name: z.string(),
  enabled: z.boolean(),
  diagnostics: z.array(diagnostic),
}).strict()
const plugin = z.object({
  id: z.uuid(),
  identity: z.string().min(1),
  name: z.string(),
  origin: z.enum(['claude', 'codex']),
  path: z.string(),
  fingerprint: z.string(),
  enabled: z.boolean(),
  items: z.array(item),
  diagnostics: z.array(diagnostic),
}).strict()
const workspace = z.object({
  plugins: z.array(plugin),
  overrides: z.record(z.string(), z.object({
    enabled: z.boolean().optional(),
    items: z.record(z.string(), z.boolean()).optional(),
  }).strict()),
}).strict()
const documentSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0),
  global: z.array(plugin),
  workspaces: z.record(z.string(), workspace),
}).strict()
type StoredPlugin = z.infer<typeof plugin>
type StoredWorkspace = z.infer<typeof workspace>
type Document = z.infer<typeof documentSchema>
/** Resolve an opaque workspace id to its canonical filesystem path. */
export type WorkspacePathResolver = (workspaceId: WorkspaceId) => string | undefined | Promise<string | undefined>
/** Host configuration for the compatibility document and bounded scans. */
export interface Config {
  /** Directory containing the Host-owned compatibility document. */
  readonly home?: string
  /** Maximum number of source files read during one scan. */
  readonly maxFiles?: number
  /** Maximum bytes read from one source file. */
  readonly maxFileBytes?: number
  /** Maximum aggregate bytes read during one scan. */
  readonly maxTotalBytes?: number
  /** Maximum directory entries visited during one scan. */
  readonly maxEntries?: number
}
/** Cordis loader schema for compatibility management bounds. */
export const Config: schema<Config> = schema.object({
  home: schema.string().min(1).required(false),
  maxFiles: schema.natural().min(1).required(false),
  maxFileBytes: schema.natural().min(1).required(false),
  maxTotalBytes: schema.natural().min(1).required(false),
  maxEntries: schema.natural().min(1).required(false),
})
/** One compatibility plugin resolved for a newly composed agent. */
export interface ResolvedManagedPlugin {
  readonly pluginId: ManagedPluginId
  readonly root: string
  readonly dataDir: string
  readonly inventory: PluginInventory
  readonly enabled: boolean
  readonly enabledItemIds: ReadonlySet<ManagedPluginItemId>
}
declare module '@deepseek-ai/cordis' { interface Context { pluginCompat: PluginCompatService } }

/** Owns a versioned, Host-owned document; existing agents retain prior composition. */
export class PluginCompatService extends Service {
  static Config = Config
  static inject = []
  private readonly path: string
  private readonly scanBounds: Pick<Config, 'maxFiles' | 'maxFileBytes' | 'maxTotalBytes' | 'maxEntries'>
  private tail = Promise.resolve()
  private disposed = false
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'pluginCompat')
    let parsed: Config
    try { parsed = Config(config) } catch (error) { throw new TypeError('plugin compatibility configuration is invalid', { cause: error }) }
    this.path = join(resolveDshHome(parsed.home), 'plugin-compat.json')
    this.scanBounds = {
      ...(parsed.maxFiles === undefined ? {} : { maxFiles: parsed.maxFiles }),
      ...(parsed.maxFileBytes === undefined ? {} : { maxFileBytes: parsed.maxFileBytes }),
      ...(parsed.maxTotalBytes === undefined ? {} : { maxTotalBytes: parsed.maxTotalBytes }),
      ...(parsed.maxEntries === undefined ? {} : { maxEntries: parsed.maxEntries }),
    }
    ctx.effect(() => async () => {
      this.disposed = true
      await this.tail.catch(() => {})
    }, 'plugin-compat.dispose')
    ctx.on('agent/created', async ({ agent, signal }) => {
      await mountManagedPlugins(agent, await this.resolveForWorkspace(agent.session.header.cwd), signal)
    })
  }
  /** Read the effective managed plugin snapshot for one scope.
   * @param scope - global or workspace document plane.
   * @param resolver - workspace identity resolver.
   * @returns authoritative snapshot and revision.
   */
  async list(scope: ManagedPluginScope, resolver: WorkspacePathResolver): Promise<ManagedPluginSnapshot> {
    this.assertOpen()
    return await this.snapshot(await this.read(), scope, resolver)
  }
  /** Resolve enabled records for a session cwd without reading repository configuration.
   * @param cwd - session working directory, when available.
   * @returns validated enabled plugin records for agent setup.
   */
  async resolveForWorkspace(cwd: string | undefined): Promise<readonly ResolvedManagedPlugin[]> {
    this.assertOpen()
    const doc = await this.read()
    let local: StoredWorkspace = { plugins: [], overrides: {} }
    if (cwd !== undefined) {
      const canonical = await realpath(cwd).catch(() => undefined)
      if (canonical !== undefined) local = doc.workspaces[canonical] ?? local
    }
    return [...doc.global, ...local.plugins].flatMap((value) => {
      const applied = view(value, local.overrides[value.id])
      if (!applied.enabled) return []
      const enabledItems = applied.items.filter(item => item.enabled)
      if (enabledItems.length === 0) return []
      const dataDir = join(this.path, '..', 'plugin-data', value.id)
      const inventory = scanPluginRoot({
        root: value.path,
        dialect: value.origin,
        pluginDataDir: dataDir,
        ...(cwd === undefined ? {} : { projectDir: cwd }),
        ...this.scanBounds,
      })
      if (!inventory.valid || inventory.fingerprint !== value.fingerprint) {
        throw new Error(`plugin compatibility activation refused: ${value.name} changed or is invalid; reimport it before activation`)
      }
      const enabledItemIds = new Set(enabledItems.map(item => item.id))
      if (enabledItems.some(item => item.kind === 'mcp' || item.kind === 'hook')) {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      }
      return [{ pluginId: applied.id, root: value.path, dataDir, inventory, enabled: applied.enabled, enabledItemIds }]
    })
  }
  /** Import one existing local plugin root after a bounded compatibility scan.
   * @param scope - global or workspace document plane.
   * @param path - existing local plugin directory.
   * @param revision - expected document revision.
   * @param resolver - workspace identity resolver.
   * @returns authoritative mutation snapshot.
   */
  async importLocal(
    scope: ManagedPluginScope,
    path: string,
    revision: number,
    resolver: WorkspacePathResolver,
  ): Promise<ManagedPluginMutation> {
    this.assertOpen()
    return await this.mutate(scope, revision, resolver, (doc, plane, all) => {
      const scanned = inspectLocalPlugin(resolve(path), this.scanBounds)
      if (!scanned.valid) throw new Error('plugin compatibility import rejected: invalid manifest')
      const added = record(scanned)
      const workspacePlugins = Object.values(doc.workspaces).flatMap(workspace => workspace.plugins)
      const duplicate = all.some(current => current.path === added.path || current.identity === added.identity)
        || (scope.kind === 'global' && workspacePlugins.some(current => current.path === added.path || current.identity === added.identity))
      if (duplicate) throw new Error('plugin compatibility import rejected: directory or plugin identity already associated')
      plane.push(added)
    })
  }
  /** Remove a managed association and any references owned by its scope.
   * @param scope - global or workspace document plane.
   * @param id - opaque managed plugin id.
   * @param revision - expected document revision.
   * @param resolver - workspace identity resolver.
   * @returns authoritative mutation snapshot.
   */
  async remove(
    scope: ManagedPluginScope,
    id: ManagedPluginId,
    revision: number,
    resolver: WorkspacePathResolver,
  ): Promise<ManagedPluginMutation> {
    this.assertOpen()
    return await this.mutate(scope, revision, resolver, (doc, plane, _all, local) => {
      const at = plane.findIndex(value => value.id === id)
      if (at < 0) throw new Error('plugin compatibility remove rejected: inherited plugin')
      plane.splice(at, 1)
      if (scope.kind === 'global') {
        for (const workspace of Object.values(doc.workspaces)) {
          Reflect.deleteProperty(workspace.overrides, id)
        }
      } else {
        Reflect.deleteProperty(local.overrides, id)
      }
    })
  }
  /** Set or clear a plugin or component enablement selection.
   * @param scope - global or workspace document plane.
   * @param target - plugin or component selection target.
   * @param enabled - selected state, or null to clear a workspace override.
   * @param revision - expected document revision.
   * @param resolver - workspace identity resolver.
   * @returns authoritative mutation snapshot.
   */
  async setEnabled(
    scope: ManagedPluginScope,
    target: ManagedPluginOverrideTarget,
    enabled: boolean | null,
    revision: number,
    resolver: WorkspacePathResolver,
  ): Promise<ManagedPluginMutation> {
    this.assertOpen()
    return await this.mutate(scope, revision, resolver, (_doc, plane, all, local) => {
      const current = (scope.kind === 'workspace' ? all : plane).find(value => value.id === target.pluginId)
      if (current === undefined) throw new Error('plugin compatibility update rejected: unknown plugin')
      const found = target.kind === 'plugin'
        ? undefined
        : current.items.find(value => value.id === target.itemId && value.kind === target.kind)
      if (target.kind !== 'plugin' && found === undefined) throw new Error('plugin compatibility update rejected: unknown item')
      if (scope.kind === 'workspace') {
        const override = local.overrides[target.pluginId] ?? { items: {} }
        if (target.kind === 'plugin') {
          if (enabled === null) Reflect.deleteProperty(override, 'enabled')
          else override.enabled = enabled
        } else {
          const items = override.items ?? {}
          if (enabled === null) Reflect.deleteProperty(items, target.itemId)
          else items[target.itemId] = enabled
          override.items = items
        }
        if (override.enabled === undefined && Object.keys(override.items ?? {}).length === 0) {
          Reflect.deleteProperty(local.overrides, target.pluginId)
        }
        else local.overrides[target.pluginId] = override
        return
      }
      if (enabled === null) throw new Error('plugin compatibility reset rejected: global has no inherited value')
      if (found === undefined) current.enabled = enabled
      else found.enabled = enabled
    })
  }
  /** Clear a workspace-local selection so it uses the imported baseline value.
   * @param scope - workspace document plane.
   * @param target - plugin or component selection target.
   * @param revision - expected document revision.
   * @param resolver - workspace identity resolver.
   * @returns authoritative mutation snapshot.
   */
  async resetOverride(
    scope: Extract<ManagedPluginScope, { kind: 'workspace' }>,
    target: ManagedPluginOverrideTarget,
    revision: number,
    resolver: WorkspacePathResolver,
  ): Promise<ManagedPluginMutation> {
    this.assertOpen()
    return await this.setEnabled(scope, target, null, revision, resolver)
  }
  private async mutate(
    scope: ManagedPluginScope,
    revision: number,
    resolver: WorkspacePathResolver,
    op: (doc: Document, plane: StoredPlugin[], all: StoredPlugin[], local: StoredWorkspace) => void,
  ): Promise<ManagedPluginMutation> {
    let result!: ManagedPluginMutation
    // A failed prior mutation must not poison the queue; its own promise still rejects to its caller.
    const run = this.tail.catch(() => {}).then(async () => {
      this.assertOpen()
      await mkdir(join(this.path, '..'), { recursive: true, mode: 0o700 })
      await withFileLock(this.path, async () => {
        const doc = await this.read()
        if (doc.revision !== revision) throw new Error('plugin compatibility update rejected: revision conflict')
        const local = await this.local(doc, scope, resolver)
        const plane = scope.kind === 'global' ? doc.global : local.plugins
        op(doc, plane, [...doc.global, ...local.plugins], local)
        doc.revision++
        result = { snapshot: this.snapshotFor(doc, scope, local) }
        await writeFileAtomic(this.path, JSON.stringify(doc, undefined, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
      })
    })
    this.tail = run
    await run
    return result
  }
  private async local(doc: Document, scope: ManagedPluginScope, resolver: WorkspacePathResolver): Promise<StoredWorkspace> {
    if (scope.kind === 'global') return { plugins: [], overrides: {} }
    const path = await resolver(scope.workspaceId)
    if (path === undefined) throw new Error('plugin compatibility operation rejected: unknown workspace')
    const canonical = await realpath(path)
    return doc.workspaces[canonical] ??= { plugins: [], overrides: {} }
  }

  private async snapshot(doc: Document, scope: ManagedPluginScope, resolver: WorkspacePathResolver): Promise<ManagedPluginSnapshot> {
    const local = await this.local(doc, scope, resolver)
    return this.snapshotFor(doc, scope, local)
  }

  private snapshotFor(
    doc: Document,
    scope: ManagedPluginScope,
    local: StoredWorkspace,
  ): ManagedPluginSnapshot {
    const globals = doc.global.map(value => view(value, local.overrides[value.id], scope.kind === 'global'))
    const locals = scope.kind === 'global' ? [] : local.plugins.map(value => view(value, local.overrides[value.id], true))
    return { scope, revision: doc.revision, activation: 'new-session-required', plugins: [...globals, ...locals] }
  }

  private async read(): Promise<Document> {
    if (!existsSync(this.path)) return { version: 1, revision: 0, global: [], workspaces: {} }
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      throw new Error('plugin compatibility state is invalid JSON', { cause: error })
    }
    const parsed = documentSchema.safeParse(raw)
    if (!parsed.success) throw new Error('plugin compatibility state has unsupported schema', { cause: parsed.error })
    return validateDocument(parsed.data)
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('plugin compatibility service is disposed')
  }
}

function validateDocument(doc: Document): Document {
  const pluginIds = new Set<string>()
  const globalIdentities = new Set<string>()
  const globalPaths = new Set<string>()
  validatePlugins(doc.global, pluginIds, globalIdentities, globalPaths)
  for (const [workspacePath, local] of Object.entries(doc.workspaces)) {
    const identities = new Set(globalIdentities)
    const paths = new Set(globalPaths)
    validatePlugins(local.plugins, pluginIds, identities, paths)
    const available = new Map(doc.global.map(value => [value.id, value]))
    for (const value of local.plugins) available.set(value.id, value)
    validateOverrides(local.overrides, available, workspacePath)
  }
  return doc
}

function validatePlugins(
  plugins: readonly StoredPlugin[],
  pluginIds: Set<string>,
  identities: Set<string>,
  paths: Set<string>,
): void {
  for (const value of plugins) {
    if (pluginIds.has(value.id)) throw new Error('plugin compatibility state has duplicate plugin id')
    pluginIds.add(value.id)
    if (identities.has(value.identity) || paths.has(value.path)) {
      throw new Error('plugin compatibility state has duplicate plugin source')
    }
    identities.add(value.identity)
    paths.add(value.path)
    const itemIds = new Set<string>()
    for (const entry of value.items) {
      if (itemIds.has(entry.id)) throw new Error('plugin compatibility state has duplicate plugin item id')
      itemIds.add(entry.id)
    }
  }
}

function validateOverrides(
  overrides: StoredWorkspace['overrides'],
  available: ReadonlyMap<string, StoredPlugin>,
  workspacePath: string,
): void {
  for (const [pluginId, override] of Object.entries(overrides)) {
    const value = available.get(pluginId)
    if (value === undefined) throw new Error(`plugin compatibility state has dangling override in workspace ${workspacePath}`)
    if (override.enabled === undefined && Object.keys(override.items ?? {}).length === 0) {
      throw new Error(`plugin compatibility state has empty override in workspace ${workspacePath}`)
    }
    for (const itemId of Object.keys(override.items ?? {})) {
      if (!value.items.some(item => item.id === itemId)) {
        throw new Error(`plugin compatibility state has dangling item override in workspace ${workspacePath}`)
      }
    }
  }
}

/** Project a scanner-validated inventory; valid scans give every retained skill a name. */
function record(value: PluginInventory): StoredPlugin {
  const diagnostics = value.diagnostics.map(entry => ({
    code: 'unsupported-component' as const,
    message: entry.message,
  }))
  const manifestName = value.manifest?.name
  const name = typeof manifestName === 'string' && manifestName.length > 0 ? manifestName : basename(value.root) || 'plugin'
  const supported = new Set(
    value.capabilities
      .filter(capability => capability.status === 'supported')
      .map(capability => capability.id),
  )
  return {
    id: randomUUID(),
    identity: value.id,
    name,
    origin: value.dialect,
    path: value.root,
    fingerprint: value.fingerprint,
    enabled: true,
    items: [
      ...value.skills
        .filter(skill => supported.has(skill.id))
        .map(skill => ({ id: skill.id, kind: 'skill' as const, name: skill.name as string, enabled: true, diagnostics: [] })),
      ...value.mcpServers
        .filter(server => supported.has(server.id))
        .map(server => ({ id: server.id, kind: 'mcp' as const, name: server.name, enabled: false, diagnostics: [] })),
      ...value.hooks
        .filter(hook => supported.has(hook.id))
        .map(hook => ({ id: hook.id, kind: 'hook' as const, name: hook.event, enabled: false, diagnostics: [] })),
    ],
    diagnostics,
  }
}

function view(value: StoredPlugin, override?: StoredWorkspace['overrides'][string], removable = false): ManagedPlugin {
  return {
    id: value.id as ManagedPluginId,
    name: value.name,
    origin: value.origin,
    path: value.path,
    removable,
    enabled: override?.enabled ?? value.enabled,
    ...(override?.enabled === undefined ? {} : { override: override.enabled }),
    items: value.items.map(current => ({
      id: current.id as ManagedPluginItemId,
      kind: current.kind,
      name: current.name,
      enabled: override?.items?.[current.id] ?? current.enabled,
      ...(override?.items?.[current.id] === undefined ? {} : { override: override.items[current.id] }),
      diagnostics: current.diagnostics,
    })),
    diagnostics: value.diagnostics,
  }
}
export default PluginCompatService
