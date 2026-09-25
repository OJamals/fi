/**
 * Bounded model-facing inspection of the current Workspace problem snapshot.
 * @module @deepseek-ai/dsh-tool-problems
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { Problem, ProblemSnapshot } from '@deepseek-ai/dsh-problems'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-problems'

/** Capability services required by this model consumer. */
export const inject = ['fs', 'tools', 'systemPrompt', 'problems']

/** Default maximum number of diagnostics rendered by one call. */
export const DEFAULT_MAX_PROBLEMS = 100

/** Default maximum rendered result size in Unicode code points. */
export const DEFAULT_MAX_RESULT_CHARS = 16_000

/** Stable model guidance for on-demand diagnostic inspection. */
export const PROBLEMS_PROMPT_TEXT =
  'Use problems after code edits or task runs to inspect current Workspace diagnostics. It returns a bounded snapshot only when called; do not assume no diagnostics exist before their producers run.'

/** Deployment-owned model result bounds. */
export interface Config {
  /** Maximum diagnostics rendered per call. Defaults to 100. */
  maxProblems?: number
  /** Maximum rendered Unicode code points per call. Defaults to 16000. */
  maxResultChars?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  maxProblems: z.number().step(1).min(1).default(DEFAULT_MAX_PROBLEMS),
  maxResultChars: z.number().step(1).min(1).default(DEFAULT_MAX_RESULT_CHARS),
})

interface ResolvedConfig {
  readonly maxProblems: number
  readonly maxResultChars: number
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Render one producer string without allowing control characters to create synthetic result lines. */
function inline(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')
}

/** Render one diagnostic in deterministic registry order. */
function renderProblem(problem: Problem): string {
  const location = problem.path === undefined
    ? '(workspace)'
    : `${inline(problem.path)}${problem.range === undefined ? '' : `:${problem.range.start.line}:${problem.range.start.column}`}`
  const owner = `${inline(String(problem.source))}${problem.code === undefined ? '' : ` ${inline(problem.code)}`}`
  return `${problem.severity} ${location} [${owner}] ${inline(problem.message)}`
}

/** Keep a model-visible result inside its configured Unicode code-point budget. */
function truncateResult(text: string, maxResultChars: number): string {
  const characters = Array.from(text)
  if (characters.length <= maxResultChars) return text
  const notice = Array.from('… output truncated.')
  if (notice.length >= maxResultChars) return notice.slice(0, maxResultChars).join('')
  return characters.slice(0, maxResultChars - notice.length).join('') + notice.join('')
}

/**
 * Format one complete snapshot with explicit entry and character limits.
 * @param snapshot - detached Workspace snapshot.
 * @param maxProblems - maximum leading diagnostics to include.
 * @param maxResultChars - maximum rendered Unicode code points.
 * @returns bounded deterministic model text.
 */
export function formatProblems(
  snapshot: ProblemSnapshot,
  maxProblems: number,
  maxResultChars: number,
): string {
  if (snapshot.problems.length === 0) return `Problems revision ${snapshot.revision}: none.`
  const visible = snapshot.problems.slice(0, maxProblems)
  const lines = [
    `Problems revision ${snapshot.revision}: ${snapshot.problems.length} total.`,
    ...visible.map(renderProblem),
  ]
  const omitted = snapshot.problems.length - visible.length
  if (omitted > 0) {
    lines.push(`… ${omitted} problem${omitted === 1 ? '' : 's'} omitted (limit ${maxProblems}).`)
  }
  return truncateResult(lines.join('\n'), maxResultChars)
}

/** Read the authoritative Workspace from the calling agent session. */
function sessionCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

/** Register the read-only `problems` tool and its on-demand guidance. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:problems',
    order: ctx.systemPrompt.getSectionOrder('TOOL_PROBLEMS'),
    text: PROBLEMS_PROMPT_TEXT,
  })
  ctx.tools.register(defineTool({
    name: 'problems',
    description: 'Inspect current diagnostics for the caller session Workspace, ordered by severity and source location.',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const workspaceRoot = sessionCwd(exec)
      if (workspaceRoot === undefined) throw new Error('the problems tool requires a session workspace cwd')
      const target = await ctx.fs.resolve(workspaceRoot, { signal: exec.signal })
      const canonicalRoot = ctx.fs.processPath(target)
      return formatProblems(ctx.problems.inspect(canonicalRoot), resolved.maxProblems, resolved.maxResultChars)
    },
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'Inspect workspace problems' }),
  }))
}

/** Resolve defaults and fail loud when direct plugin callers bypass Schemastery. */
function resolveConfig(config: Config): ResolvedConfig {
  const maxProblems = config.maxProblems ?? DEFAULT_MAX_PROBLEMS
  const maxResultChars = config.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
  if (!Number.isSafeInteger(maxProblems) || maxProblems < 1) {
    throw new TypeError('tool-problems: maxProblems must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxResultChars) || maxResultChars < 1) {
    throw new TypeError('tool-problems: maxResultChars must be a positive safe integer')
  }
  return { maxProblems, maxResultChars }
}
