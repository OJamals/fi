import { Context } from '@deepseek-ai/cordis'
import Problems, { ProblemSourceId } from '@deepseek-ai/dsh-problems'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as ToolProblems from '../src/index.ts'

const workspaceRoot = '/workspace'
const signal = new AbortController().signal
let sequence = 0

async function mount(config: ToolProblems.Config = {}): Promise<Context> {
  const ctx = new Context()
  ctx.provide('fs', {
    resolve: async (path: string) => ({
      targetKey: path === '/workspace-alias' ? workspaceRoot : path,
      displayPath: path,
    }),
    processPath: (target: { targetKey: string }) => target.targetKey,
  } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Problems)
  await ctx.plugin(ToolProblems, config)
  return ctx
}

function call(ctx: Context, cwd: string | null = workspaceRoot) {
  return ctx.tools.execute({
    signal,
    callId: `problems-${++sequence}` as never,
    name: 'problems',
    arguments: {},
    ...cwd === null ? {} : { agent: { session: { header: { cwd } } } as never },
  })
}

describe('tool-problems registration', () => {
  it('registers one parameterless tool and prompt guidance', async () => {
    const ctx = await mount()

    expect(ctx.tools.get('problems')?.parameters).toEqual({
      type: 'object',
      properties: {},
    })
    const prompt = await ctx.systemPrompt.assemble()
    expect(prompt.sections.map(section => section.text).join('\n')).toContain(ToolProblems.PROBLEMS_PROMPT_TEXT)
  })

  it('rejects invalid result bounds at load', async () => {
    await expect(mount({ maxProblems: 0 })).rejects.toThrow(/maxProblems/)
    await expect(mount({ maxResultChars: 0 })).rejects.toThrow(/maxResultChars/)
  })
})

describe('tool-problems execution', () => {
  it('renders an empty snapshot without injecting it into every model request', async () => {
    const ctx = await mount()

    const result = await call(ctx)

    expect(result).toMatchObject({ isError: false, value: 'Problems revision 0: none.' })
    expect(result.content).toEqual([{ type: 'text', text: 'Problems revision 0: none.' }])
  })

  it('uses only the caller session Workspace and preserves registry order', async () => {
    const ctx = await mount()
    ctx.problems.replace(workspaceRoot, ProblemSourceId('typescript'), [{
      severity: 'warning',
      message: 'Unused value',
      path: 'src/b.ts',
      range: { start: { line: 8, column: 4 } },
      code: 'TS6133',
    }])
    ctx.problems.replace(workspaceRoot, ProblemSourceId('eslint'), [{
      severity: 'error',
      message: 'Unexpected any',
      path: 'src/a.ts',
      range: { start: { line: 2, column: 3 } },
    }])

    const result = await call(ctx)

    expect(result.value).toBe([
      'Problems revision 2: 2 total.',
      'error src/a.ts:2:3 [eslint] Unexpected any',
      'warning src/b.ts:8:4 [typescript TS6133] Unused value',
    ].join('\n'))
  })

  it('resolves Session cwd aliases before reading canonical Problems', async () => {
    const ctx = await mount()
    ctx.problems.replace(workspaceRoot, ProblemSourceId('typescript'), [{
      severity: 'error',
      message: 'Broken alias target',
    }])

    const result = await call(ctx, '/workspace-alias')

    expect(result.value).toContain('Broken alias target')
  })

  it('reports omitted entries at the configured problem limit', async () => {
    const ctx = await mount({ maxProblems: 1 })
    ctx.problems.replace(workspaceRoot, ProblemSourceId('compiler'), [
      { severity: 'error', message: 'First' },
      { severity: 'warning', message: 'Second' },
    ])

    const result = await call(ctx)

    expect(result.value).toBe([
      'Problems revision 1: 2 total.',
      'error (workspace) [compiler] First',
      '… 1 problem omitted (limit 1).',
    ].join('\n'))
  })

  it('caps rendered output by Unicode code points', async () => {
    const ctx = await mount({ maxResultChars: 48 })
    ctx.problems.replace(workspaceRoot, ProblemSourceId('compiler'), [{
      severity: 'error',
      message: '🩺'.repeat(100),
    }])

    const result = await call(ctx)

    expect(Array.from(result.value as string)).toHaveLength(48)
    expect(result.value).toMatch(/… output truncated\.$/)
  })

  it('fails when no agent session Workspace owns the call', async () => {
    const ctx = await mount()

    const result = await call(ctx, null)

    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/session workspace cwd/)
  })
})
