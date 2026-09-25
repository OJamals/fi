import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import Problems, { ProblemSourceId, type ProblemInput } from '@deepseek-ai/dsh-problems'

const root = '/workspace'
const source = ProblemSourceId('typescript')

function problem(overrides: Partial<ProblemInput> = {}): ProblemInput {
  return {
    severity: 'error',
    message: 'Cannot find name',
    path: 'src/main.ts',
    range: { start: { line: 3, column: 5 } },
    ...overrides,
  }
}

async function mount(config: Record<string, number> = {}): Promise<{ ctx: Context; problems: Problems }> {
  const ctx = new Context()
  await ctx.plugin(Problems, config)
  return { ctx, problems: ctx.problems }
}

describe('Problems', () => {
  it('atomically replaces one source and returns detached snapshots', async () => {
    const { problems } = await mount()
    const first = problems.replace(root, source, [problem()])

    expect(first).toEqual({
      revision: 1,
      problems: [{ ...problem(), source }],
    })

    ;(first.problems[0] as { message: string }).message = 'changed by caller'
    expect(problems.inspect(root).problems[0]?.message).toBe('Cannot find name')
  })

  it('sorts visible problems and treats producer ordering as idempotent', async () => {
    const { problems } = await mount()
    const warning = problem({ severity: 'warning', message: 'later', range: { start: { line: 8, column: 1 } } })
    const error = problem({ severity: 'error', message: 'first', range: { start: { line: 2, column: 1 } } })

    expect(problems.replace(root, source, [warning, error]).revision).toBe(1)
    expect(problems.replace(root, source, [error, warning]).revision).toBe(1)
    expect(problems.inspect(root).problems.map(entry => entry.message)).toEqual(['first', 'later'])
  })

  it('replaces sources independently and clears with an empty replacement', async () => {
    const { problems } = await mount()
    const eslint = ProblemSourceId('eslint')
    problems.replace(root, source, [problem()])
    problems.replace(root, eslint, [problem({ severity: 'warning', message: 'lint' })])

    expect(problems.inspect(root)).toMatchObject({ revision: 2, problems: [{ source }, { source: eslint }] })
    expect(problems.replace(root, source, [])).toMatchObject({ revision: 3, problems: [{ source: eslint }] })
    expect(problems.replace(root, source, []).revision).toBe(3)
  })

  it('delivers full snapshots, isolates listener failures, and stops after disposal', async () => {
    const { problems } = await mount()
    const failed = vi.fn(() => { throw new Error('listener broke') })
    const seen = vi.fn()
    const disposeFailed = problems.subscribe(root, failed)
    const disposeSeen = problems.subscribe(root, seen)

    problems.replace(root, source, [problem()])
    expect(failed).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }))

    disposeFailed()
    disposeSeen()
    problems.replace(root, source, [])
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid input without changing prior state', async () => {
    const { problems } = await mount()
    problems.replace(root, source, [problem()])

    expect(() => problems.replace(root, source, [problem({
      severity: 'toString' as ProblemInput['severity'],
    })])).toThrow(/unsupported severity/)
    expect(() => problems.replace(root, source, [problem({ path: '../outside.ts' })]))
      .toThrow(/Workspace-relative/)
    expect(() => problems.replace(root, source, [problem({ range: { start: { line: 0, column: 1 } } })]))
      .toThrow(/positive safe integer/)
    expect(() => problems.replace(root, source, [{
      severity: 'error', message: 'Cannot find name', range: { start: { line: 1, column: 1 } },
    }]))
      .toThrow(/range requires path/)
    expect(problems.inspect(root)).toMatchObject({ revision: 1, problems: [{ message: 'Cannot find name' }] })
  })

  it('does not retain Workspace state for empty or rejected first replacements', async () => {
    const { problems } = await mount({ maxProblemsPerWorkspace: 1 })

    expect(problems.replace('/empty', source, [])).toEqual({ revision: 0, problems: [] })
    expect(() => problems.replace('/rejected', source, [
      problem({ message: 'first' }),
      problem({ message: 'second' }),
    ])).toThrow(/Workspace problem limit/)

    const workspaces = (problems as unknown as {
      readonly workspaces: ReadonlyMap<string, unknown>
    }).workspaces
    expect(workspaces.size).toBe(0)
  })

  it('enforces configured source, per-source, total, and string bounds', async () => {
    const shortSource = ProblemSourceId('ts')
    const { problems } = await mount({
      maxSourcesPerWorkspace: 1,
      maxProblemsPerSource: 1,
      maxProblemsPerWorkspace: 1,
      maxMessageBytes: 4,
      maxSourceBytes: 4,
      maxCodeBytes: 4,
      maxPathBytes: 8,
    })

    expect(() => problems.replace(root, ProblemSourceId('longer'), [])).toThrow(/source exceeds/)
    expect(() => problems.replace(root, shortSource, [problem({ message: '12345' })])).toThrow(/message exceeds/)
    expect(() => problems.replace(root, shortSource, [problem({ message: 'ok', path: 'long/path.ts' })])).toThrow(/path exceeds/)
    expect(() => problems.replace(root, shortSource, [problem({ message: 'ok', code: '12345' })])).toThrow(/code exceeds/)

    problems.replace(root, shortSource, [problem({ message: 'ok', path: 'a.ts' })])
    expect(() => problems.replace(root, shortSource, [problem({ message: 'a', path: 'a.ts' }), problem({ message: 'b', path: 'b.ts' })]))
      .toThrow(/per-source problem limit/)
    expect(() => problems.replace(root, ProblemSourceId('lint'), [problem({ message: 'ok', path: 'a.ts' })]))
      .toThrow(/source limit/)
  })
})
