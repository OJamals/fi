import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import * as PluginCompatCommand from '../src/command.ts'
import { PluginCompatService } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function harness(home: string): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(PluginCompatService, { home })
  await ctx.plugin(PluginCompatCommand)
  contexts.push(ctx)
  const handle = await ctx.agents.create({ sessionId: SessionId(`plugin-compat-command-${contexts.length}-${roots.length}`) })
  return { ctx, agent: handle.agent }
}

async function run(ctx: Context, agent: Agent, line: string): Promise<CommandResult> {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`command line did not resolve: ${line}`)
  return execution.result
}

async function fixturePlugin(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-command-'))
  roots.push(root)
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await mkdir(join(root, 'skills', 'one'), { recursive: true })
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, skills: ['./skills'] }))
  await writeFile(join(root, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: one\n---\nbody\n')
  return root
}

describe('plugin-compat command surface', () => {
  it('reports no imported plugins before any import', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-command-home-'))
    roots.push(home)
    const { ctx, agent } = await harness(home)
    const result = await run(ctx, agent, '/plugin-list')
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('No imported Claude or Codex plugins') })
  })

  it('rejects /plugin-import with no path as a usage error', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-command-home-'))
    roots.push(home)
    const { ctx, agent } = await harness(home)
    const result = await run(ctx, agent, '/plugin-import   ')
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('Usage: /plugin-import') })
  })

  it('imports a plugin, lists it, and reports a scanner rejection as an error', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-command-home-'))
    roots.push(home)
    const { ctx, agent } = await harness(home)
    const plugin = await fixturePlugin('demo-plugin')

    const imported = await run(ctx, agent, `/plugin-import ${plugin}`)
    expect(imported).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('Imported "demo-plugin" (claude)'),
    })
    expect(imported.kind === 'success' ? imported.text : '').toContain('Run /plugin-list to review it')

    const listed = await run(ctx, agent, '/plugin-list')
    expect(listed).toMatchObject({ kind: 'success', text: expect.stringContaining('demo-plugin') })

    const invalid = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-command-invalid-'))
    roots.push(invalid)
    const rejected = await run(ctx, agent, `/plugin-import ${invalid}`)
    expect(rejected).toMatchObject({ kind: 'error', text: expect.stringContaining('invalid manifest') })
  })

  it('rejects malformed /plugin-enable and /plugin-disable targets as usage errors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-command-home-'))
    roots.push(home)
    const { ctx, agent } = await harness(home)

    await expect(run(ctx, agent, '/plugin-enable')).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('Usage: /plugin-enable') })
    await expect(run(ctx, agent, '/plugin-disable one two three')).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('Usage: /plugin-disable') })
    await expect(run(ctx, agent, '/plugin-enable plugin-id bogus:item')).resolves.toMatchObject({ kind: 'error' })
    await expect(run(ctx, agent, '/plugin-enable plugin-id skill:')).resolves.toMatchObject({ kind: 'error' })
  })

  it('enables and disables a whole plugin and one of its items, and reports unknown plugins as errors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-command-home-'))
    roots.push(home)
    const { ctx, agent } = await harness(home)
    const plugin = await fixturePlugin('toggle-plugin')
    await run(ctx, agent, `/plugin-import ${plugin}`)
    const listed = await run(ctx, agent, '/plugin-list')
    const pluginId = (listed.kind === 'success' ? listed.text ?? '' : '').match(/^\[on\] +(\S+)/m)?.[1]
    if (pluginId === undefined) throw new Error('fixture plugin id was not found in /plugin-list output')

    const disabledPlugin = await run(ctx, agent, `/plugin-disable ${pluginId}`)
    expect(disabledPlugin).toMatchObject({ kind: 'success', text: expect.stringContaining(`Disabled ${pluginId}`) })

    const enabledItem = await run(ctx, agent, `/plugin-enable ${pluginId} skill:skill:one`)
    expect(enabledItem).toMatchObject({ kind: 'success', text: expect.stringContaining('Enabled skill:skill:one') })

    const unknown = await run(ctx, agent, '/plugin-enable 00000000-0000-4000-8000-000000000000')
    expect(unknown).toMatchObject({ kind: 'error', text: expect.stringContaining('unknown plugin') })
  })

  it('removes an imported plugin and reports removal of an unknown id as an error', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-command-home-'))
    roots.push(home)
    const { ctx, agent } = await harness(home)
    const plugin = await fixturePlugin('removable-plugin')
    await run(ctx, agent, `/plugin-import ${plugin}`)
    const listed = await run(ctx, agent, '/plugin-list')
    const pluginId = (listed.kind === 'success' ? listed.text ?? '' : '').match(/^\[on\] +(\S+)/m)?.[1]
    if (pluginId === undefined) throw new Error('fixture plugin id was not found in /plugin-list output')

    const removed = await run(ctx, agent, `/plugin-remove ${pluginId}`)
    expect(removed).toMatchObject({ kind: 'success', text: expect.stringContaining(`Removed plugin ${pluginId}`) })
    await expect(run(ctx, agent, '/plugin-list')).resolves.toMatchObject({ kind: 'success', text: expect.stringContaining('No imported Claude or Codex plugins') })

    await expect(run(ctx, agent, '/plugin-remove missing-removal')).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('inherited plugin') })
  })

  it('rejects an empty /plugin-remove target as a usage error', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-command-home-'))
    roots.push(home)
    const { ctx, agent } = await harness(home)
    await expect(run(ctx, agent, '/plugin-remove   ')).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('Usage: /plugin-remove') })
  })

  it('retries a revision conflict from two concurrent enable commands and settles both', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-command-home-'))
    roots.push(home)
    const { ctx, agent } = await harness(home)
    const first = await fixturePlugin('concurrent-a')
    const second = await fixturePlugin('concurrent-b')
    await run(ctx, agent, `/plugin-import ${first}`)
    await run(ctx, agent, `/plugin-import ${second}`)
    const listed = await run(ctx, agent, '/plugin-list')
    const text = listed.kind === 'success' ? listed.text ?? '' : ''
    const ids = [...text.matchAll(/^\[on\] +(\S+)/gm)].map(match => match[1] as string)
    expect(ids).toHaveLength(2)

    const [resultA, resultB] = await Promise.all([
      run(ctx, agent, `/plugin-disable ${ids[0]}`),
      run(ctx, agent, `/plugin-disable ${ids[1]}`),
    ])
    expect(resultA).toMatchObject({ kind: 'success' })
    expect(resultB).toMatchObject({ kind: 'success' })
  })
})
