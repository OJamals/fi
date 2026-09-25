import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, vi } from 'vitest'
import { mountManagedPlugins } from '../src/runtime.ts'
import { PluginCompatService } from '../src/index.ts'
import type { PluginHook, PluginInventory } from '../src/manifest.ts'
import type { ResolvedManagedPlugin } from '../src/index.ts'
import type { ManagedPluginId, ManagedPluginItemId } from '../src/types.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function harness(
  adapter: MockAdapter = new MockAdapter([textResponse('ok')]),
  options: { readonly skills?: boolean } = {},
): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (options.skills !== false) await ctx.plugin(SkillRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/**
 * Mount `mountManagedPlugins` directly on `agent/created`, standing in for a
 * real `PluginCompatService` selection so the fixture can hand-pick which
 * resolved plugins apply to which agent.
 */
function mountOnCreate(
  ctx: Context,
  select: (agent: Agent) => readonly ResolvedManagedPlugin[],
): void {
  ctx.on('agent/created', async ({ agent, signal }) => { await mountManagedPlugins(agent, select(agent), signal) })
}

function resolved(
  root: string,
  pluginId: string,
  enabledItemIds: readonly string[],
  mcpConfig?: unknown,
  hooks: readonly PluginHook[] = [],
  dialect: PluginInventory['dialect'] = 'codex',
): ResolvedManagedPlugin {
  const inventory: PluginInventory = {
    id: `codex:${pluginId}`,
    dialect,
    root,
    skills: [{
      id: 'skill:workspace-rule',
      path: join(root, 'SKILL.md'),
      name: 'workspace-rule',
      description: 'A workspace-local rule.',
      source: { path: join(root, 'SKILL.md'), sha256: 'fixture', text: '---\nname: workspace-rule\ndescription: A workspace-local rule.\n---\nUse this workspace only.' },
      resources: [],
    }],
    mcpServers: mcpConfig === undefined ? [] : [{
      id: 'mcp:disabled-server',
      name: 'disabled-server',
      config: mcpConfig,
    }],
    hooks,
    capabilities: [
      { id: 'skill:workspace-rule', kind: 'skill', status: 'supported' },
      ...mcpConfig === undefined ? [] : [{ id: 'mcp:disabled-server', kind: 'mcp' as const, status: 'supported' as const }],
      ...hooks.map(hook => ({ id: hook.id, kind: 'hook' as const, status: 'supported' as const })),
    ],
    diagnostics: [],
    sources: [],
    fingerprint: 'fixture',
    valid: true,
  }
  return {
    pluginId: pluginId as ManagedPluginId,
    root,
    dataDir: join(root, '.data'),
    inventory,
    enabled: true,
    enabledItemIds: new Set(enabledItemIds.map(id => id as ManagedPluginItemId)),
  }
}

describe('managed compatibility runtime', () => {
  async function mockedRuntime(fsOverrides: {
    readonly mkdtemp?: (path: string) => Promise<string>
    readonly writeFile?: (...args: Parameters<typeof writeFile>) => Promise<void>
  }): Promise<typeof import('../src/runtime.ts')> {
    vi.resetModules()
    vi.doMock('node:fs/promises', async importOriginal => ({
      ...await importOriginal<typeof import('node:fs/promises')>(),
      ...fsOverrides,
    }))
    return import('../src/runtime.ts')
  }

  it('mounts enabled skills in each agent scope and never starts a disabled executable', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-'))
    const marker = join(fixture, 'disabled-ran')
    try {
      await writeFile(join(fixture, 'SKILL.md'), '---\nname: workspace-rule\ndescription: A workspace-local rule.\n---\nUse this workspace only.')
      const first = resolved(fixture, '11111111-1111-4111-8111-111111111111', ['skill:workspace-rule'], { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] })
      const second = resolved(fixture, '22222222-2222-4222-8222-222222222222', [])
      const ctx = await harness()
      mountOnCreate(ctx, agent => agent.session.header.cwd === '/workspace-a' ? [first] : [second])

      const one = await ctx.agents.create({ sessionId: SessionId('managed-runtime-a'), meta: { cwd: '/workspace-a' } })
      const two = await ctx.agents.create({ sessionId: SessionId('managed-runtime-b'), meta: { cwd: '/workspace-b' } })

      expect((await ctx.skills.list({ scope: one.agent })).map(skill => skill.name)).toEqual([
        expect.stringMatching(/^managed-dsh-plugin-compat-runtime-[a-z0-9]+-workspace-rule-[0-9a-f]{8}$/),
      ])
      expect(await ctx.skills.list({ scope: two.agent })).toEqual([])
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

      await one.dispose()
      expect(await ctx.skills.list({ scope: one.agent })).toEqual([])
      await two.dispose()
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('rejects publication and leaves no scoped registration when managed setup fails', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-failure-'))
    try {
      await writeFile(join(fixture, 'SKILL.md'), '---\nname: workspace-rule\ndescription: A workspace-local rule.\n---\nUse this workspace only.')
      const plugin = resolved(fixture, '33333333-3333-4333-8333-333333333333', ['skill:workspace-rule'])
      const ctx = await harness()
      ctx.on('agent/created', async ({ agent }) => {
        await mountManagedPlugins(agent, [plugin])
        throw new Error('managed setup failed')
      })

      await expect(ctx.agents.create({ sessionId: SessionId('managed-runtime-failed') })).rejects.toThrow('managed setup failed')
      expect(ctx.agents.get(SessionId('managed-runtime-failed'))).toBeUndefined()
      expect(ctx.sessions.get(SessionId('managed-runtime-failed'))).toBeUndefined()
      expect(await ctx.skills.list()).toEqual([])
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a missing enabled capability before a managed child plugin can remain pending', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-missing-capability-'))
    try {
      await writeFile(join(fixture, 'SKILL.md'), '---\nname: workspace-rule\ndescription: A workspace-local rule.\n---\nUse this workspace only.')
      const plugin = resolved(fixture, '77777777-7777-4777-8777-777777777777', ['skill:workspace-rule'])
      const ctx = await harness(undefined, { skills: false })
      let scopeDisposed = false
      ctx.on('agent/created', ({ agent }) => {
        agent.ctx.effect(() => () => { scopeDisposed = true }, 'managed-preflight-cleanup-fixture')
      })
      ctx.on('agent/created', async ({ agent }) => { await mountManagedPlugins(agent, [plugin]) })

      await expect(ctx.agents.create({ sessionId: SessionId('managed-runtime-missing-capability') }))
        .rejects.toThrow(/managed plugin .*skill .*skill:workspace-rule.*missing required services skills/)
      expect(scopeDisposed).toBe(true)
      expect(ctx.agents.get(SessionId('managed-runtime-missing-capability'))).toBeUndefined()
      expect(ctx.sessions.get(SessionId('managed-runtime-missing-capability'))).toBeUndefined()
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('starts a new agent when every supported item is disabled and its source is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-disabled-source-'))
    const home = join(root, 'home')
    const source = join(root, 'plugin')
    try {
      await mkdir(join(source, '.claude-plugin'), { recursive: true })
      await mkdir(join(source, 'skills', 'rule'), { recursive: true })
      await writeFile(
        join(source, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'disabled-source' }),
      )
      await writeFile(
        join(source, 'skills', 'rule', 'SKILL.md'),
        '---\nname: rule\ndescription: A temporary rule.\n---\nDo not load me.\n',
      )
      const ctx = await harness()
      await ctx.plugin(PluginCompatService, { home })
      const global = { kind: 'global' } as const
      const imported = await ctx.pluginCompat.importLocal(global, source, 0, async () => undefined)
      const plugin = imported.snapshot.plugins[0]
      if (plugin === undefined) throw new Error('fixture plugin was not imported')
      const skill = plugin.items[0]
      if (skill === undefined) throw new Error('fixture skill was not imported')
      await ctx.pluginCompat.setEnabled(
        global,
        { kind: 'skill', pluginId: plugin.id, itemId: skill.id },
        false,
        imported.snapshot.revision,
        async () => undefined,
      )
      await rm(source, { recursive: true, force: true })

      const handle = await ctx.agents.create({ sessionId: SessionId('managed-runtime-disabled-source') })
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('awaits MCP startup failure before publication', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-mcp-failure-'))
    const marker = join(fixture, 'mcp-started')
    try {
      const plugin = resolved(fixture, '44444444-4444-4444-8444-444444444444', ['mcp:disabled-server'], { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] })
      const ctx = await harness()
      ctx.on('agent/created', async ({ agent }) => { await mountManagedPlugins(agent, [plugin]) })

      await expect(ctx.agents.create({ sessionId: SessionId('managed-runtime-mcp-failed') })).rejects.toThrow(/initial connection or tool synchronization failed/)
      await expect(readFile(marker, 'utf8')).resolves.toBe('ran')
      expect(ctx.agents.get(SessionId('managed-runtime-mcp-failed'))).toBeUndefined()
      expect(ctx.sessions.get(SessionId('managed-runtime-mcp-failed'))).toBeUndefined()
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('cancels pending MCP startup without publishing an agent or leaking its child process', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-mcp-cancel-'))
    const started = join(fixture, 'started')
    const terminated = join(fixture, 'terminated')
    let ctx: Context | undefined
    try {
      const script = [
        `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started')`,
        `process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(terminated)}, 'terminated'); process.exit(0) })`,
        'setInterval(() => {}, 1_000)',
      ].join(';')
      const plugin = resolved(fixture, '88888888-8888-4888-8888-888888888888', ['mcp:disabled-server'], {
        command: process.execPath,
        args: ['-e', script],
      })
      ctx = await harness()
      mountOnCreate(ctx, () => [plugin])
      const controller = new AbortController()
      const sessionId = SessionId('managed-runtime-mcp-cancel')
      const creating = ctx.agents.create({ sessionId, signal: controller.signal })

      await vi.waitFor(async () => { await expect(readFile(started, 'utf8')).resolves.toBe('started') })
      controller.abort(new Error('cancel managed MCP startup'))

      await expect(creating).rejects.toThrow('cancel managed MCP startup')
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      expect(ctx.sessions.get(sessionId)).toBeUndefined()
      await vi.waitFor(async () => { await expect(readFile(terminated, 'utf8')).resolves.toBe('terminated') })
    } finally {
      await ctx?.fiber.dispose()
      await rm(fixture, { recursive: true, force: true })
    }
  }, 15_000)

  it('publishes an enabled MCP tool before the first model request and removes it on disposal', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-mcp-success-'))
    try {
      const adapter = new MockAdapter([textResponse('ok')])
      const plugin = resolved(fixture, '55555555-5555-4555-8555-555555555555', ['mcp:disabled-server'], {
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('../../../mcp/mcp-client/tests/fixture-server.ts', import.meta.url))],
      })
      const ctx = await harness(adapter)
      mountOnCreate(ctx, () => [plugin])
      const handle = await ctx.agents.create({ sessionId: SessionId('managed-runtime-mcp-success'), agentOptions: { provider: 'mock', model: 'mock' } })

      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContainEqual(expect.stringMatching(/^mcp__pc_[0-9a-f]{20}__add$/))

      await handle.dispose()
      expect(ctx.tools.schemas(handle.agent).map(tool => tool.name))
        .not.toContainEqual(expect.stringMatching(/^mcp__pc_[0-9a-f]{20}__add$/))
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }, 15_000)

  it('runs an enabled UserPromptSubmit hook before the first model request and removes its private config on disposal', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-hook-success-'))
    const marker = join(fixture, 'hook-ran')
    const temporaryBefore = new Set(await readdir(tmpdir()))
    try {
      const plugin = resolved(fixture, '66666666-6666-4666-8666-666666666666', ['hook:UserPromptSubmit:0:0'], undefined, [{
        id: 'hook:UserPromptSubmit:0:0', event: 'UserPromptSubmit', command: `touch ${JSON.stringify(marker)}`, sourcePath: join(fixture, 'hooks.json'),
      }])
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(adapter)
      await ctx.plugin(LocalSubprocessRuntime).await()
      await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 }).await()
      mountOnCreate(ctx, () => [plugin])
      const handle = await ctx.agents.create({ sessionId: SessionId('managed-runtime-hook-success'), agentOptions: { provider: 'mock', model: 'mock' } })

      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      await expect(readFile(marker, 'utf8')).resolves.toBe('')
      expect(adapter.requests).toHaveLength(1)

      await handle.dispose()
      expect((await readdir(tmpdir())).filter(name => name.startsWith('dsh-managed-hooks-') && !temporaryBefore.has(name))).toEqual([])
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }, 15_000)

  it('leaves a disabled managed plugin absent from its prepared agent scope', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-plugin-disabled-'))
    try {
      await writeFile(join(fixture, 'SKILL.md'), '---\nname: workspace-rule\ndescription: A workspace-local rule.\n---\nDo not load.\n')
      const selected = resolved(fixture, '99999999-9999-4999-8999-999999999999', ['skill:workspace-rule'])
      const ctx = await harness()
      mountOnCreate(ctx, () => [{ ...selected, enabled: false }])

      const handle = await ctx.agents.create({ sessionId: SessionId('managed-runtime-plugin-disabled') })
      expect(await ctx.skills.list({ scope: handle.agent })).toEqual([])
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a selected MCP server with a non-object configuration before publication', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-invalid-mcp-'))
    try {
      const plugin = resolved(fixture, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ['mcp:disabled-server'], null)
      const ctx = await harness()
      ctx.on('agent/created', async ({ agent }) => { await mountManagedPlugins(agent, [plugin]) })

      await expect(ctx.agents.create({ sessionId: SessionId('managed-runtime-invalid-mcp') }))
        .rejects.toThrow('managed MCP configuration is invalid')
      expect(ctx.agents.get(SessionId('managed-runtime-invalid-mcp'))).toBeUndefined()
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a selected MCP server that declares neither supported transport before publication', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-unsupported-mcp-'))
    try {
      const plugin = resolved(fixture, 'ffffffff-ffff-4fff-8fff-ffffffffffff', ['mcp:disabled-server'], {})
      const ctx = await harness()
      ctx.on('agent/created', async ({ agent }) => { await mountManagedPlugins(agent, [plugin]) })

      await expect(ctx.agents.create({ sessionId: SessionId('managed-runtime-unsupported-mcp') }))
        .rejects.toThrow('has no supported transport')
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('drops non-string stdio arguments before a selected MCP process fails startup', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-invalid-args-'))
    try {
      const plugin = resolved(fixture, '14141414-1414-4414-8414-141414141414', ['mcp:disabled-server'], {
        command: 'false', args: [1], cwd: fixture,
      })
      const ctx = await harness()
      ctx.on('agent/created', async ({ agent }) => { await mountManagedPlugins(agent, [plugin]) })

      await expect(ctx.agents.create({ sessionId: SessionId('managed-runtime-invalid-args') }))
        .rejects.toThrow(/initial connection or tool synchronization failed/)
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('uses a scanner fallback skill identifier when imported frontmatter omits a name', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-fallback-skill-'))
    try {
      await writeFile(join(fixture, 'SKILL.md'), '---\nname: workspace-rule\ndescription: Workspace rule\n---\nUse this workspace only.\n')
      const base = resolved(fixture, '12121212-1212-4212-8212-121212121212', ['skill:workspace-rule'])
      const skill = base.inventory.skills[0]
      if (skill === undefined) throw new Error('fixture skill is absent')
      const { name: _name, ...skillWithoutName } = skill
      const plugin = { ...base, inventory: { ...base.inventory, skills: [{ ...skillWithoutName }] } }
      const ctx = await harness()
      mountOnCreate(ctx, () => [plugin])

      const handle = await ctx.agents.create({ sessionId: SessionId('managed-runtime-fallback-skill') })
      expect((await ctx.skills.list({ scope: handle.agent }))[0]?.name).toMatch(/^managed-[a-z0-9-]+-skill-workspace-rule-[0-9a-f]{8}$/)
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('configures selected streamable-HTTP MCP headers before refusing an unavailable endpoint', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-http-mcp-'))
    try {
      const plugin = resolved(fixture, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ['mcp:disabled-server'], {
        url: 'http://127.0.0.1:1/mcp',
        headers: { authorization: 'Bearer fixture', ignored: 1 },
      })
      const ctx = await harness()
      ctx.on('agent/created', async ({ agent }) => { await mountManagedPlugins(agent, [plugin]) })

      await expect(ctx.agents.create({ sessionId: SessionId('managed-runtime-http-mcp') }))
        .rejects.toThrow(/initial connection or tool synchronization failed/)
      expect(ctx.agents.get(SessionId('managed-runtime-http-mcp'))).toBeUndefined()
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('normalizes punctuation-only skill names and supplies a description when imported metadata omits one', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-normalized-skill-'))
    try {
      await writeFile(join(fixture, 'SKILL.md'), '---\nname: workspace-rule\ndescription: Workspace rule\n---\nUse this workspace only.\n')
      const base = resolved(fixture, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', ['skill:workspace-rule'])
      const skill = base.inventory.skills[0]
      if (skill === undefined) throw new Error('fixture skill is absent')
      const { name: _name, description: _description, ...skillWithoutMetadata } = skill
      const plugin = {
        ...base,
        inventory: {
          ...base.inventory,
          manifest: { name: '!!!' },
          skills: [{ ...skillWithoutMetadata, name: '***' }],
        },
      }
      const ctx = await harness()
      mountOnCreate(ctx, () => [plugin])

      const handle = await ctx.agents.create({ sessionId: SessionId('managed-runtime-normalized-skill') })
      const skills = await ctx.skills.list({ scope: handle.agent })
      expect(skills).toHaveLength(1)
      expect(skills[0]?.name).toMatch(/^managed-plugin-plugin-[0-9a-f]{8}$/)
      expect(skills[0]?.description).toBe('Imported compatibility plugin skill')
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('runs a Codex hook matcher with its declared timeout', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-hook-options-'))
    const marker = join(fixture, 'hook-options-ran')
    try {
      const plugin = resolved(fixture, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ['hook:UserPromptSubmit:0:0'], undefined, [{
        id: 'hook:UserPromptSubmit:0:0', event: 'UserPromptSubmit', matcher: 'Bash', command: `touch ${JSON.stringify(marker)}`,
        timeoutSec: 2, sourcePath: join(fixture, 'hooks.json'),
      }])
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(adapter)
      await ctx.plugin(LocalSubprocessRuntime).await()
      await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 }).await()
      mountOnCreate(ctx, () => [plugin])
      const handle = await ctx.agents.create({
        sessionId: SessionId('managed-runtime-hook-options'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })

      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      await expect(readFile(marker, 'utf8')).resolves.toBe('')
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }, 15_000)

  it('awaits delayed hook directory creation before cancellation teardown completes', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-hook-cancel-mkdtemp-'))
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const started = Promise.withResolvers<true>()
    const release = Promise.withResolvers<true>()
    let directory: string | undefined
    const runtime = await mockedRuntime({
      mkdtemp: async (path) => {
        const created = await actual.mkdtemp(path)
        directory = created
        started.resolve(true)
        await release.promise
        return created
      },
    })
    const plugin = resolved(fixture, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', ['hook:UserPromptSubmit:0:0'], undefined, [{
      id: 'hook:UserPromptSubmit:0:0', event: 'UserPromptSubmit', command: 'true', sourcePath: join(fixture, 'hooks.json'),
    }])
    const ctx = await harness()
    await ctx.plugin(LocalSubprocessRuntime).await()
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 }).await()
    const controller = new AbortController()
    const sessionId = SessionId('managed-runtime-hook-cancel-mkdtemp')
    ctx.on('agent/created', async ({ agent }) => { await runtime.mountManagedPlugins(agent, [plugin]) })
    const creating = ctx.agents.create({ sessionId, signal: controller.signal })
    let settled = false
    void creating.then(() => { settled = true }, () => { settled = true })
    try {
      await started.promise
      controller.abort(new Error('cancel delayed hook directory creation'))
      await Promise.resolve()
      expect(settled).toBe(false)
      release.resolve(true)
      await expect(creating).rejects.toThrow('cancel delayed hook directory creation')
      expect(directory).toBeDefined()
      await expect(actual.readdir(directory!)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      release.resolve(true)
      await ctx.fiber.dispose()
      await rm(fixture, { recursive: true, force: true })
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  }, 15_000)

  it('awaits delayed hook config writing before cancellation teardown completes', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-hook-cancel-write-'))
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const started = Promise.withResolvers<true>()
    const release = Promise.withResolvers<true>()
    let directory: string | undefined
    const runtime = await mockedRuntime({
      writeFile: async (...args) => {
        directory = typeof args[0] === 'string' ? dirname(args[0]) : undefined
        started.resolve(true)
        await release.promise
        await actual.writeFile(...args)
      },
    })
    const plugin = resolved(fixture, 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', ['hook:UserPromptSubmit:0:0'], undefined, [{
      id: 'hook:UserPromptSubmit:0:0', event: 'UserPromptSubmit', command: 'true', sourcePath: join(fixture, 'hooks.json'),
    }])
    const ctx = await harness()
    await ctx.plugin(LocalSubprocessRuntime).await()
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 }).await()
    const controller = new AbortController()
    const sessionId = SessionId('managed-runtime-hook-cancel-write')
    ctx.on('agent/created', async ({ agent }) => { await runtime.mountManagedPlugins(agent, [plugin]) })
    const creating = ctx.agents.create({ sessionId, signal: controller.signal })
    let settled = false
    void creating.then(() => { settled = true }, () => { settled = true })
    try {
      await started.promise
      controller.abort(new Error('cancel delayed hook config writing'))
      await Promise.resolve()
      expect(settled).toBe(false)
      release.resolve(true)
      await expect(creating).rejects.toThrow('cancel delayed hook config writing')
      expect(directory).toBeDefined()
      await expect(actual.readdir(directory!)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      release.resolve(true)
      await ctx.fiber.dispose()
      await rm(fixture, { recursive: true, force: true })
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  }, 15_000)

  it('runs a selected Claude hook with its workspace project directory', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-claude-hook-'))
    const marker = join(fixture, 'claude-hook-ran')
    try {
      const plugin = resolved(fixture, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ['hook:UserPromptSubmit:0:0'], undefined, [{
        id: 'hook:UserPromptSubmit:0:0', event: 'UserPromptSubmit', command: `touch ${JSON.stringify(marker)}`, sourcePath: join(fixture, 'hooks.json'),
      }], 'claude')
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(adapter)
      await ctx.plugin(LocalSubprocessRuntime).await()
      await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 }).await()
      mountOnCreate(ctx, () => [plugin])
      const handle = await ctx.agents.create({
        sessionId: SessionId('managed-runtime-claude-hook'),
        meta: { cwd: fixture },
        agentOptions: { provider: 'mock', model: 'mock' },
      })

      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      await expect(readFile(marker, 'utf8')).resolves.toBe('')
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }, 15_000)

  it('removes the hook directory when writing its config fails', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-hook-write-failure-'))
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const writeFailure = new Error('hook config write failed')
    let directory: string | undefined
    const runtime = await mockedRuntime({
      writeFile: async (...args) => {
        directory = typeof args[0] === 'string' ? dirname(args[0]) : undefined
        throw writeFailure
      },
    })
    const plugin = resolved(fixture, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', ['hook:UserPromptSubmit:0:0'], undefined, [{
      id: 'hook:UserPromptSubmit:0:0', event: 'UserPromptSubmit', command: 'true', sourcePath: join(fixture, 'hooks.json'),
    }])
    const ctx = await harness()
    await ctx.plugin(LocalSubprocessRuntime).await()
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 }).await()
    const sessionId = SessionId('managed-runtime-hook-write-failure')
    ctx.on('agent/created', async ({ agent }) => { await runtime.mountManagedPlugins(agent, [plugin]) })
    try {
      await expect(ctx.agents.create({ sessionId })).rejects.toBe(writeFailure)
      expect(directory).toBeDefined()
      await expect(actual.readdir(directory!)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await ctx.fiber.dispose()
      await rm(fixture, { recursive: true, force: true })
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  }, 15_000)

  it('runs a selected Claude hook without a workspace project directory', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-runtime-claude-hook-no-cwd-'))
    const marker = join(fixture, 'claude-hook-no-cwd-ran')
    try {
      const plugin = resolved(fixture, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ['hook:UserPromptSubmit:0:0'], undefined, [{
        id: 'hook:UserPromptSubmit:0:0', event: 'UserPromptSubmit', command: `touch ${JSON.stringify(marker)}`, sourcePath: join(fixture, 'hooks.json'),
      }], 'claude')
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(adapter)
      await ctx.plugin(LocalSubprocessRuntime).await()
      await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 }).await()
      mountOnCreate(ctx, () => [plugin])
      const handle = await ctx.agents.create({
        sessionId: SessionId('managed-runtime-claude-hook-no-cwd'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })

      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      await expect(readFile(marker, 'utf8')).resolves.toBe('')
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }, 15_000)
})
