import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginCompatService } from '../src/index.ts'
import type { ManagedPluginId, ManagedPluginItemId } from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function workspaceId(value: string): WorkspaceId {
  return value as WorkspaceId
}

function pluginId(value: string): ManagedPluginId {
  return value as ManagedPluginId
}

function itemId(value: string): ManagedPluginItemId {
  return value as ManagedPluginItemId
}

async function fixture(): Promise<{
  ctx: Context
  handle: Fiber
  service: PluginCompatService
  home: string
  plugin: string
  a: string
  b: string
  resolve: (id: string) => Promise<string | undefined>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-'))
  roots.push(root)
  const home = join(root, 'home')
  const plugin = join(root, 'plugin')
  const a = join(root, 'a')
  const b = join(root, 'b')
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(join(plugin, '.claude-plugin'), { recursive: true }),
    mkdir(join(plugin, 'skills', 'one'), { recursive: true }),
    mkdir(a),
    mkdir(b),
  ])
  await writeFile(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fixture', skills: ['./skills'] }),
  )
  await writeFile(
    join(plugin, 'skills', 'one', 'SKILL.md'),
    '---\nname: one\ndescription: one\n---\nbody\n',
  )
  const ctx = new Context()
  const handle = ctx.plugin(PluginCompatService, { home })
  await handle
  contexts.push(ctx)
  const service = ctx.pluginCompat
  const resolve = async (id: string): Promise<string | undefined> => {
    if (id === 'a') return a
    if (id === 'b') return b
    return undefined
  }
  return { ctx, handle, service, home, plugin, a, b, resolve }
}

describe('PluginCompatService persistence', () => {
  it('wraps invalid scanner bounds as configuration errors', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => new PluginCompatService(ctx, { maxFiles: 0 })).toThrow('plugin compatibility configuration is invalid')
  })

  it('imports a removable global plugin and isolates workspace override reset', async () => {
    const h = await fixture()
    const global = { kind: 'global' } as const
    const a = { kind: 'workspace', workspaceId: workspaceId('a') } as const
    const b = { kind: 'workspace', workspaceId: workspaceId('b') } as const
    const imported = await h.service.importLocal(global, h.plugin, 0, h.resolve)
    const plugin = imported.snapshot.plugins[0]
    if (plugin === undefined) throw new Error('fixture plugin was not imported')
    expect(plugin.removable).toBe(true)
    const item = plugin.items[0]
    if (item === undefined) throw new Error('fixture skill was not discovered')
    const changed = await h.service.setEnabled(
      a,
      { kind: 'plugin', pluginId: plugin.id },
      false,
      1,
      h.resolve,
    )
    expect(changed.snapshot.plugins[0]?.enabled).toBe(false)
    expect((await h.service.list(b, h.resolve)).plugins[0]?.enabled).toBe(true)
    const itemChanged = await h.service.setEnabled(
      a,
      { kind: 'skill', pluginId: plugin.id, itemId: item.id },
      false,
      2,
      h.resolve,
    )
    expect(itemChanged.snapshot.plugins[0]?.items[0]?.enabled).toBe(false)
    const reset = await h.service.resetOverride(
      a,
      { kind: 'skill', pluginId: plugin.id, itemId: item.id },
      3,
      h.resolve,
    )
    expect(reset.snapshot.plugins[0]?.items[0]?.enabled).toBe(true)
    const resetPlugin = await h.service.resetOverride(
      a,
      { kind: 'plugin', pluginId: plugin.id },
      reset.snapshot.revision,
      h.resolve,
    )
    expect(resetPlugin.snapshot.plugins[0]).toMatchObject({ enabled: true })
    expect(resetPlugin.snapshot.plugins[0]).not.toHaveProperty('override')
  })

  it('permits one local source to be associated independently with two workspaces', async () => {
    const h = await fixture()
    const a = { kind: 'workspace', workspaceId: workspaceId('a') } as const
    const b = { kind: 'workspace', workspaceId: workspaceId('b') } as const

    await h.service.importLocal(a, h.plugin, 0, h.resolve)
    const imported = await h.service.importLocal(b, h.plugin, 1, h.resolve)

    expect(imported.snapshot.plugins).toHaveLength(1)
    expect((await h.service.list(a, h.resolve)).plugins).toHaveLength(1)
  })

  it('rejects a global association for a root already owned by a workspace', async () => {
    const h = await fixture()
    const a = { kind: 'workspace', workspaceId: workspaceId('a') } as const
    await h.service.importLocal(a, h.plugin, 0, h.resolve)

    await expect(h.service.importLocal({ kind: 'global' }, h.plugin, 1, h.resolve))
      .rejects.toThrow('already associated')

    expect((await h.service.list(a, h.resolve)).revision).toBe(1)
  })

  it('rejects stale revisions, unknown scope and forged targets, then recovers after failure', async () => {
    const h = await fixture()
    const global = { kind: 'global' } as const
    const a = { kind: 'workspace', workspaceId: workspaceId('a') } as const
    const imported = await h.service.importLocal(global, h.plugin, 0, h.resolve)
    const plugin = imported.snapshot.plugins[0]
    if (plugin === undefined) throw new Error('fixture plugin was not imported')
    const skill = plugin.items[0]
    if (skill === undefined) throw new Error('fixture skill was not imported')
    await expect(
      h.service.setEnabled(a, { kind: 'plugin', pluginId: pluginId('missing') }, false, 1, h.resolve),
    ).rejects.toThrow('unknown plugin')
    await expect(
      h.service.list({ kind: 'workspace', workspaceId: workspaceId('missing') }, h.resolve),
    ).rejects.toThrow('unknown workspace')
    await expect(
      h.service.setEnabled(
        global,
        { kind: 'skill', pluginId: plugin.id, itemId: itemId('missing') },
        false,
        1,
        h.resolve,
      ),
    ).rejects.toThrow('unknown item')
    await expect(
      h.service.setEnabled(
        global,
        { kind: 'mcp', pluginId: plugin.id, itemId: skill.id },
        false,
        1,
        h.resolve,
      ),
    ).rejects.toThrow('unknown item')
    await expect(
      h.service.setEnabled(global, { kind: 'plugin', pluginId: plugin.id }, false, 0, h.resolve),
    ).rejects.toThrow('revision conflict')
    await expect(
      h.service.setEnabled(global, { kind: 'plugin', pluginId: plugin.id }, false, 1, h.resolve),
    ).resolves.toBeDefined()
  })

  it('rejects malformed durable state, preserves sources on removal, and refuses changed config', async () => {
    const h = await fixture()
    const global = { kind: 'global' } as const
    await writeFile(join(h.home, 'plugin-compat.json'), JSON.stringify({ version: 2 }))
    await expect(h.service.list(global, h.resolve)).rejects.toThrow('unsupported schema')
    await rm(join(h.home, 'plugin-compat.json'))
    const added = await h.service.importLocal(global, h.plugin, 0, h.resolve)
    const plugin = added.snapshot.plugins[0]
    if (plugin === undefined) throw new Error('fixture plugin was not imported')
    await h.service.remove(global, plugin.id, 1, h.resolve)
    await expect(writeFile(join(h.plugin, 'kept.txt'), 'yes')).resolves.toBeUndefined()
    const readded = await h.service.importLocal(global, h.plugin, 2, h.resolve)
    await writeFile(join(h.plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'changed' }))
    await expect(h.service.resolveForWorkspace(undefined)).rejects.toThrow('changed or is invalid')
    expect(readded.snapshot.plugins).toHaveLength(1)
  })

  it('rejects unrecognized durable fields and dangling persisted references', async () => {
    const h = await fixture()
    const global = { kind: 'global' } as const
    const state = join(h.home, 'plugin-compat.json')

    await writeFile(state, JSON.stringify({ version: 1, revision: 0, global: [], workspaces: {}, extra: true }))
    await expect(h.service.list(global, h.resolve)).rejects.toThrow('unsupported schema')

    await writeFile(state, JSON.stringify({ version: 1, revision: 0, global: [], workspaces: {} }))
    await h.service.importLocal(global, h.plugin, 0, h.resolve)
    const persisted = JSON.parse(await readFile(state, 'utf8')) as { workspaces: Record<string, unknown> }
    persisted.workspaces[h.a] = {
      plugins: [],
      overrides: { '00000000-0000-4000-8000-000000000000': { enabled: false } },
    }
    await writeFile(state, JSON.stringify(persisted))
    await expect(h.service.list(global, h.resolve)).rejects.toThrow('dangling override')
  })

  it('uses the workspace resolver once before commit and returns its committed snapshot', async () => {
    const h = await fixture()
    const workspaceScope = { kind: 'workspace', workspaceId: workspaceId('a') } as const
    let calls = 0
    const resolver = async (): Promise<string | undefined> => {
      calls++
      return calls === 1 ? h.a : undefined
    }

    const result = await h.service.importLocal(workspaceScope, h.plugin, 0, resolver)

    expect(calls).toBe(1)
    expect(result.snapshot.revision).toBe(1)
    expect(result.snapshot.plugins).toHaveLength(1)
  })

  it('drains an active mutation while disposal rejects queued and later work', async () => {
    const h = await fixture()
    const workspaceScope = { kind: 'workspace', workspaceId: workspaceId('a') } as const
    const secondPlugin = join(h.plugin, '..', 'plugin-second')
    await mkdir(join(secondPlugin, '.claude-plugin'), { recursive: true })
    await writeFile(join(secondPlugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'second' }))
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const resolver = async (id: WorkspaceId): Promise<string | undefined> => {
      if (id !== workspaceId('a')) return undefined
      started()
      await held
      return h.a
    }

    const active = h.service.importLocal(workspaceScope, h.plugin, 0, resolver)
    await startedPromise
    const queued = h.service.importLocal(workspaceScope, secondPlugin, 1, h.resolve)
    const disposing = h.handle.dispose()
    release()

    await expect(active).resolves.toMatchObject({ snapshot: { revision: 1 } })
    await expect(queued).rejects.toThrow('disposed')
    await expect(disposing).resolves.toBeUndefined()
    await expect(h.service.list({ kind: 'global' }, h.resolve)).rejects.toThrow('disposed')
  })

  it('serializes revisions across two services sharing one durable document', async () => {
    const h = await fixture()
    const global = { kind: 'global' } as const
    const imported = await h.service.importLocal(global, h.plugin, 0, h.resolve)
    const managed = imported.snapshot.plugins[0]
    if (managed === undefined) throw new Error('fixture plugin was not imported')
    const secondContext = new Context()
    contexts.push(secondContext)
    await secondContext.plugin(PluginCompatService, { home: h.home })

    await secondContext.pluginCompat.setEnabled(
      global,
      { kind: 'plugin', pluginId: managed.id },
      false,
      1,
      h.resolve,
    )
    await expect(
      h.service.setEnabled(global, { kind: 'plugin', pluginId: managed.id }, true, 1, h.resolve),
    ).rejects.toThrow('revision conflict')
  })

  it('resolves selected MCP and hook records with a private data directory for a canonical workspace', async () => {
    const h = await fixture()
    const global = { kind: 'global' } as const
    await writeFile(join(h.plugin, 'mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'echo' } } }))
    await writeFile(join(h.plugin, 'hooks.json'), JSON.stringify({ hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hook' }] }],
    } }))
    await writeFile(
      join(h.plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'fixture', skills: ['./skills'], mcpServers: './mcp.json', hooks: './hooks.json' }),
    )

    const imported = await h.service.importLocal(global, h.plugin, 0, h.resolve)
    const plugin = imported.snapshot.plugins[0]
    if (plugin === undefined) throw new Error('fixture plugin was not imported')
    const mcp = plugin.items.find(item => item.kind === 'mcp')
    const hook = plugin.items.find(item => item.kind === 'hook')
    if (mcp === undefined || hook === undefined) throw new Error('fixture plugin components were not imported')
    const mcpEnabled = await h.service.setEnabled(global, { kind: 'mcp', pluginId: plugin.id, itemId: mcp.id }, true, 1, h.resolve)
    await h.service.setEnabled(global, { kind: 'hook', pluginId: plugin.id, itemId: hook.id }, true, mcpEnabled.snapshot.revision, h.resolve)

    const resolved = await h.service.resolveForWorkspace(h.a)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ root: plugin.path, enabled: true })
    expect([...resolved[0]!.enabledItemIds]).toEqual(expect.arrayContaining(['skill:one', mcp.id, hook.id]))
    await expect(readFile(join(h.home, 'plugin-data', plugin.id))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('rejects invalid imports, inherited removal, and a global reset without changing the document', async () => {
    const h = await fixture()
    const global = { kind: 'global' } as const
    const workspace = { kind: 'workspace', workspaceId: workspaceId('a') } as const
    const invalid = join(h.plugin, '..', 'invalid')
    await mkdir(invalid)
    await expect(h.service.importLocal(global, invalid, 0, h.resolve)).rejects.toThrow('invalid manifest')

    const imported = await h.service.importLocal(global, h.plugin, 0, h.resolve)
    const plugin = imported.snapshot.plugins[0]
    if (plugin === undefined) throw new Error('fixture plugin was not imported')
    await expect(h.service.remove(workspace, plugin.id, 1, h.resolve)).rejects.toThrow('inherited plugin')
    await expect(h.service.setEnabled(global, { kind: 'plugin', pluginId: plugin.id }, null, 1, h.resolve))
      .rejects.toThrow('global has no inherited value')
    expect((await h.service.list(global, h.resolve)).revision).toBe(1)
  })

  it('rejects invalid JSON and duplicate or dangling durable records before exposing them', async () => {
    const h = await fixture()
    const global = { kind: 'global' } as const
    const state = join(h.home, 'plugin-compat.json')
    await writeFile(state, '{')
    await expect(h.service.list(global, h.resolve)).rejects.toThrow('invalid JSON')

    await writeFile(state, JSON.stringify({ version: 1, revision: 0, global: [], workspaces: {} }))
    await h.service.importLocal(global, h.plugin, 0, h.resolve)
    const document = JSON.parse(await readFile(state, 'utf8')) as {
      global: Array<{ id: string; items: Array<{ id: string }> }>
      workspaces: Record<string, { plugins: unknown[]; overrides: Record<string, unknown> }>
    }
    const plugin = document.global[0]
    if (plugin === undefined) throw new Error('fixture plugin was not persisted')

    document.global.push({ ...plugin })
    await writeFile(state, JSON.stringify(document))
    await expect(h.service.list(global, h.resolve)).rejects.toThrow('duplicate plugin id')

    document.global.pop()
    document.global.push({ ...plugin, id: '00000000-0000-4000-8000-000000000000' })
    await writeFile(state, JSON.stringify(document))
    await expect(h.service.list(global, h.resolve)).rejects.toThrow('duplicate plugin source')

    document.global.pop()
    plugin.items.push({ ...plugin.items[0]! })
    await writeFile(state, JSON.stringify(document))
    await expect(h.service.list(global, h.resolve)).rejects.toThrow('duplicate plugin item id')

    plugin.items.pop()
    document.workspaces[h.a] = { plugins: [], overrides: { [plugin.id]: { items: {} } } }
    await writeFile(state, JSON.stringify(document))
    await expect(h.service.list(global, h.resolve)).rejects.toThrow('empty override')

    document.workspaces[h.a] = { plugins: [], overrides: { [plugin.id]: { items: { missing: false } } } }
    await writeFile(state, JSON.stringify(document))
    await expect(h.service.list(global, h.resolve)).rejects.toThrow('dangling item override')
  })

  it('removes global selections without disturbing a distinct workspace-local plugin', async () => {
    const h = await fixture()
    const global = { kind: 'global' } as const
    const workspace = { kind: 'workspace', workspaceId: workspaceId('b') } as const
    const second = join(h.plugin, '..', 'plugin-local')
    await mkdir(join(second, '.claude-plugin'), { recursive: true })
    await writeFile(join(second, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'local' }))

    const importedGlobal = await h.service.importLocal(global, h.plugin, 0, h.resolve)
    const globalPlugin = importedGlobal.snapshot.plugins[0]
    if (globalPlugin === undefined) throw new Error('global fixture plugin was not imported')
    const importedLocal = await h.service.importLocal(workspace, second, importedGlobal.snapshot.revision, h.resolve)
    expect(importedLocal.snapshot.plugins).toHaveLength(2)

    const removed = await h.service.remove(global, globalPlugin.id, importedLocal.snapshot.revision, h.resolve)
    expect(removed.snapshot.plugins).toEqual([])
    expect((await h.service.list(workspace, h.resolve)).plugins).toMatchObject([{ name: 'local', removable: true }])
  })

  it('removes a workspace-local plugin and clears its private override', async () => {
    const h = await fixture()
    const workspace = { kind: 'workspace', workspaceId: workspaceId('a') } as const
    const imported = await h.service.importLocal(workspace, h.plugin, 0, h.resolve)
    const plugin = imported.snapshot.plugins[0]
    if (plugin === undefined) throw new Error('workspace fixture plugin was not imported')
    const disabled = await h.service.setEnabled(
      workspace,
      { kind: 'plugin', pluginId: plugin.id },
      false,
      imported.snapshot.revision,
      h.resolve,
    )

    const removed = await h.service.remove(workspace, plugin.id, disabled.snapshot.revision, h.resolve)
    expect(removed.snapshot.plugins).toEqual([])
  })

  it('uses configured scan bounds and ignores a non-canonical session directory', async () => {
    const h = await fixture()
    const configured = new Context()
    contexts.push(configured)
    await configured.plugin(PluginCompatService, {
      home: h.home,
      maxFiles: 8,
      maxFileBytes: 1_024,
      maxTotalBytes: 4_096,
      maxEntries: 16,
    })
    const global = { kind: 'global' } as const
    await configured.pluginCompat.importLocal(global, h.plugin, 0, h.resolve)

    await expect(configured.pluginCompat.resolveForWorkspace(join(h.a, 'missing'))).resolves.toHaveLength(1)
    const plugin = (await configured.pluginCompat.list(global, h.resolve)).plugins[0]
    if (plugin === undefined) throw new Error('configured fixture plugin was not imported')
    const disabled = await configured.pluginCompat.setEnabled(
      global,
      { kind: 'plugin', pluginId: plugin.id },
      false,
      1,
      h.resolve,
    )
    await expect(configured.pluginCompat.resolveForWorkspace(undefined)).resolves.toEqual([])
    expect(disabled.snapshot.plugins[0]).toMatchObject({ enabled: false })
  })

  it('clears sparse persisted workspace overrides after updating a selected skill', async () => {
    const h = await fixture()
    const global = { kind: 'global' } as const
    const workspace = { kind: 'workspace', workspaceId: workspaceId('a') } as const
    const imported = await h.service.importLocal(global, h.plugin, 0, h.resolve)
    const plugin = imported.snapshot.plugins[0]
    const skill = plugin?.items[0]
    if (plugin === undefined || skill === undefined) throw new Error('fixture plugin skill was not imported')
    const state = join(h.home, 'plugin-compat.json')
    const document = JSON.parse(await readFile(state, 'utf8')) as {
      workspaces: Record<string, { plugins: unknown[]; overrides: Record<string, unknown> }>
    }
    document.workspaces[await realpath(h.a)] = { plugins: [], overrides: { [plugin.id]: { enabled: false } } }
    await writeFile(state, JSON.stringify(document))

    const selected = await h.service.setEnabled(
      workspace,
      { kind: 'skill', pluginId: plugin.id, itemId: skill.id },
      true,
      1,
      h.resolve,
    )
    const reset = await h.service.resetOverride(
      workspace,
      { kind: 'plugin', pluginId: plugin.id },
      selected.snapshot.revision,
      h.resolve,
    )
    expect(reset.snapshot.plugins[0]).not.toHaveProperty('override')

    const sparse = JSON.parse(await readFile(state, 'utf8')) as {
      workspaces: Record<string, { plugins: unknown[]; overrides: Record<string, unknown> }>
    }
    sparse.workspaces[await realpath(h.a)] = { plugins: [], overrides: { [plugin.id]: { enabled: false } } }
    await writeFile(state, JSON.stringify(sparse))
    const directReset = await h.service.resetOverride(
      workspace,
      { kind: 'plugin', pluginId: plugin.id },
      reset.snapshot.revision,
      h.resolve,
    )
    expect(directReset.snapshot.plugins[0]).not.toHaveProperty('override')
  })

  it('records supported plugin metadata and non-fatal scanner diagnostics', async () => {
    const h = await fixture()
    const global = { kind: 'global' } as const
    const diagnosed = join(h.plugin, '..', 'diagnosed')
    await mkdir(join(diagnosed, '.claude-plugin'), { recursive: true })
    await mkdir(join(diagnosed, 'skills', 'named'), { recursive: true })
    await writeFile(join(diagnosed, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'diagnosed', skills: './skills', unsupportedMetadata: true,
    }))
    await writeFile(join(diagnosed, 'skills', 'named', 'SKILL.md'), '---\nname: named\ndescription: Named\n---\nbody\n')

    const imported = await h.service.importLocal(global, diagnosed, 0, h.resolve)
    expect(imported.snapshot.plugins[0]).toMatchObject({
      name: 'diagnosed',
      items: [{ kind: 'skill', name: 'named' }],
      diagnostics: [expect.objectContaining({ code: 'unsupported-component' })],
    })

    const inferred = join(h.plugin, '..', 'inferred')
    await mkdir(join(inferred, 'skills', 'named'), { recursive: true })
    await writeFile(join(inferred, 'skills', 'named', 'SKILL.md'), '---\nname: named\ndescription: Named\n---\nbody\n')
    const inferredImported = await h.service.importLocal(global, inferred, imported.snapshot.revision, h.resolve)
    expect(inferredImported.snapshot.plugins[1]).toMatchObject({ name: 'inferred' })

    const state = join(h.home, 'plugin-compat.json')
    const document = JSON.parse(await readFile(state, 'utf8')) as {
      workspaces: Record<string, { plugins: unknown[]; overrides: Record<string, unknown> }>
    }
    document.workspaces[await realpath(h.a)] = { plugins: [], overrides: { [imported.snapshot.plugins[0]!.id]: {} } }
    await writeFile(state, JSON.stringify(document))
    await expect(h.service.list({ kind: 'workspace', workspaceId: workspaceId('a') }, h.resolve)).rejects.toThrow('empty override')
  })

  it('projects a valid root-directory inventory with its stable fallback display name', async () => {
    const h = await fixture()
    vi.resetModules()
    vi.doMock('../src/manifest.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/manifest.ts')>()
      return {
        ...actual,
        inspectLocalPlugin: () => ({
          id: 'claude:root', dialect: 'claude', root: '/', skills: [], mcpServers: [], hooks: [], capabilities: [],
          diagnostics: [], sources: [], fingerprint: 'root-fixture', valid: true,
        }),
      }
    })
    try {
      const { PluginCompatService: FreshPluginCompatService } = await import('../src/index.ts')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(FreshPluginCompatService, { home: h.home })
      const imported = await ctx.pluginCompat.importLocal({ kind: 'global' }, '/', 0, h.resolve)
      const plugin = imported.snapshot.plugins[0]
      expect(plugin).toMatchObject({ name: 'plugin', path: '/', removable: true })
      if (plugin === undefined) throw new Error('root fixture plugin was not imported')
      const removed = await ctx.pluginCompat.remove({ kind: 'global' }, plugin.id, imported.snapshot.revision, h.resolve)
      expect(removed.snapshot.plugins).toEqual([])
    } finally {
      vi.doUnmock('../src/manifest.ts')
      vi.resetModules()
    }
  })
})
