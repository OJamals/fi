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
  it('orders file diagnostics before workspace diagnostics and codes before uncoded entries', async () => {
    const { problems } = await mount()
    const entries: ProblemInput[] = [
      { severity: 'info', message: 'workspace' },
      { severity: 'info', message: 'b', path: 'b.ts' },
      { severity: 'info', message: 'uncoded', path: 'a.ts' },
      { severity: 'info', message: 'second code', path: 'a.ts', code: 'B' },
      { severity: 'info', message: 'first code', path: 'a.ts', code: 'A' },
    ]
    const snapshot = problems.replace(root, source, entries)
    expect(snapshot.problems.map(entry => entry.message)).toEqual([
      'first code', 'second code', 'uncoded', 'b', 'workspace',
    ])
    expect(problems.replace(root, source, entries.toReversed())).toEqual(snapshot)
  })

  it('validates range ends and detaches returned positions', async () => {
    const { problems } = await mount()
    for (const end of [{ line: 2, column: 8 }, { line: 3, column: 4 }]) {
      expect(() => problems.replace(root, source, [problem({
        range: { start: { line: 3, column: 5 }, end },
      })])).toThrow(/must not precede/)
    }
    expect(() => problems.replace(root, source, [problem({
      range: { start: { line: 3, column: 5 }, end: { line: 4, column: 0 } },
    })])).toThrow(/range.end.column/)
    for (const end of [{ line: 3, column: 5 }, { line: 4, column: 1 }]) {
      const entry = problem({ range: { start: { line: 3, column: 5 }, end } })
      const snapshot = problems.replace(root, source, [entry])
      expect(snapshot.problems[0]?.range?.end).toEqual(end)
      expect(snapshot.problems[0]?.range?.end).not.toBe(end)
      expect(problems.replace(root, source, [entry]).revision).toBe(snapshot.revision)
    }
  })

  it('rejects empty identifiers, messages, and invalid direct configuration', async () => {
    const { problems } = await mount()
    for (const workspace of [' ', '/bad\0path']) {
      expect(() => problems.inspect(workspace)).toThrow(/workspaceRoot/)
    }
    for (const id of [' ', 'bad\nid']) {
      expect(() => problems.replace(root, ProblemSourceId(id), [])).toThrow(/single-line id/)
    }
    expect(() => problems.replace(root, source, [problem({ message: '' })])).toThrow(/message must be non-empty/)
    for (const value of [0, 1.5]) {
      expect(() => new Problems(new Context(), { maxProblemsPerSource: value })).toThrow(/positive safe integer/)
    }
  })

  it('contains asynchronous listener rejection without losing later notifications', async () => {
    const { ctx, problems } = await mount()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const dispose = problems.subscribe(root, async () => { throw new Error('async listener broke') })
    const seen = vi.fn()
    problems.subscribe(root, seen)
    problems.replace(root, source, [problem()])
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('async listener broke')) })
    dispose()
    dispose()
    problems.replace(root, source, [])
    expect(seen).toHaveBeenCalledTimes(2)
    warn.mockRestore()
    await ctx.fiber.dispose()
  })

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

  it('keeps empty and rejected first replacements observationally empty', async () => {
    const { problems } = await mount({ maxProblemsPerWorkspace: 1 })

    expect(problems.replace('/empty', source, [])).toEqual({ revision: 0, problems: [] })
    expect(() => problems.replace('/rejected', source, [
      problem({ message: 'first' }),
      problem({ message: 'second' }),
    ])).toThrow(/Workspace problem limit/)

    expect(problems.inspect('/empty')).toEqual({ revision: 0, problems: [] })
    expect(problems.inspect('/rejected')).toEqual({ revision: 0, problems: [] })
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
