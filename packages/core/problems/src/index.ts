/**
 * Revisioned Workspace diagnostics registry. Producers atomically replace one bounded source contribution;
 * consumers inspect or subscribe to complete deterministic snapshots.
 * @module @deepseek-ai/dsh-problems
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  Problem, ProblemInput, ProblemListener, ProblemPosition, ProblemSnapshot, ProblemSourceId,
} from './types.ts'

export { ProblemSourceId } from './types.ts'
export type {
  Problem, ProblemInput, ProblemListener, ProblemPosition, ProblemRange, ProblemSeverity, ProblemSnapshot,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Revisioned coding diagnostics keyed by canonical Workspace root. */
    problems: Problems
  }
}

/** Deployment bounds for producer contributions and stored diagnostic strings. */
export interface Config {
  /** Maximum active producer sources per Workspace. */
  maxSourcesPerWorkspace?: number
  /** Maximum problems accepted in one source replacement. */
  maxProblemsPerSource?: number
  /** Maximum problems retained across all sources in one Workspace. */
  maxProblemsPerWorkspace?: number
  /** Maximum UTF-8 bytes in one message. */
  maxMessageBytes?: number
  /** Maximum UTF-8 bytes in one source id. */
  maxSourceBytes?: number
  /** Maximum UTF-8 bytes in one diagnostic code. */
  maxCodeBytes?: number
  /** Maximum UTF-8 bytes in one Workspace-relative path. */
  maxPathBytes?: number
}

/** Schemastery config for {@link Problems}. */
export const Config: z<Config> = z.object({
  maxSourcesPerWorkspace: z.natural().min(1).default(32),
  maxProblemsPerSource: z.natural().min(1).default(500),
  maxProblemsPerWorkspace: z.natural().min(1).default(2_000),
  maxMessageBytes: z.natural().min(1).default(16_384),
  maxSourceBytes: z.natural().min(1).default(256),
  maxCodeBytes: z.natural().min(1).default(256),
  maxPathBytes: z.natural().min(1).default(4_096),
})

type ResolvedConfig = Required<Config>

interface WorkspaceState {
  revision: number
  readonly sources: Map<ProblemSourceId, Problem[]>
}

const severityOrder: Readonly<Record<Problem['severity'], number>> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
}

const encoder = new TextEncoder()

/** Compare optional strings with absent values after present values. */
function compareOptional(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  return left.localeCompare(right)
}

/** Stable user-facing problem order. */
function compareProblems(left: Problem, right: Problem): number {
  return severityOrder[left.severity] - severityOrder[right.severity]
    || compareOptional(left.path, right.path)
    || (left.range?.start.line ?? 0) - (right.range?.start.line ?? 0)
    || (left.range?.start.column ?? 0) - (right.range?.start.column ?? 0)
    || String(left.source).localeCompare(String(right.source))
    || compareOptional(left.code, right.code)
    || left.message.localeCompare(right.message)
}

/** Exact equality after validation and deterministic construction. */
function sameProblem(left: Problem, right: Problem): boolean {
  return left.source === right.source
    && left.severity === right.severity
    && left.message === right.message
    && left.path === right.path
    && left.code === right.code
    && left.range?.start.line === right.range?.start.line
    && left.range?.start.column === right.range?.start.column
    && left.range?.end?.line === right.range?.end?.line
    && left.range?.end?.column === right.range?.end?.column
}

/** Compare two normalized source contributions. */
function sameProblems(left: readonly Problem[], right: readonly Problem[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index]
    return candidate !== undefined && sameProblem(entry, candidate)
  })
}

/** Return UTF-8 byte length without depending on Node globals. */
function bytes(value: string): number {
  return encoder.encode(value).byteLength
}

/** Validate one positive one-based position. */
function validatePosition(position: ProblemPosition, label: string): void {
  for (const [name, value] of Object.entries(position)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`problems: ${label}.${name} must be a positive safe integer`)
    }
  }
}

/** Validate and normalize one Workspace-relative path to slash separators. */
function normalizePath(value: string, maxBytes: number): string {
  if (bytes(value) > maxBytes) throw new Error(`problems: path exceeds ${maxBytes} UTF-8 bytes`)
  const path = value.replaceAll('\\', '/')
  const segments = path.split('/')
  if (path.length === 0 || path.startsWith('/') || /^[A-Za-z]:\//.test(path)
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('problems: path must be a Workspace-relative file path without traversal')
  }
  return path
}

/** Copy one range after structural checks. */
function normalizeRange(input: ProblemInput): Problem['range'] {
  if (input.range === undefined) return undefined
  if (input.path === undefined) throw new Error('problems: range requires path')
  validatePosition(input.range.start, 'range.start')
  if (input.range.end !== undefined) {
    validatePosition(input.range.end, 'range.end')
    const endBeforeStart = input.range.end.line < input.range.start.line
      || (input.range.end.line === input.range.start.line
        && input.range.end.column < input.range.start.column)
    if (endBeforeStart) throw new Error('problems: range.end must not precede range.start')
  }
  return {
    start: { ...input.range.start },
    ...input.range.end === undefined ? {} : { end: { ...input.range.end } },
  }
}

/** Detached copy safe for callers and listeners to mutate. */
function copyProblem(problem: Problem): Problem {
  return {
    severity: problem.severity,
    message: problem.message,
    source: problem.source,
    ...problem.path === undefined ? {} : { path: problem.path },
    ...problem.code === undefined ? {} : { code: problem.code },
    ...problem.range === undefined ? {} : {
      range: {
        start: { ...problem.range.start },
        ...problem.range.end === undefined ? {} : { end: { ...problem.range.end } },
      },
    },
  }
}

/** Concrete process-local Problems provider and registry. */
export class Problems extends Service {
  static Config: z<Config> = Config

  private readonly config: ResolvedConfig
  private readonly workspaces = new Map<string, WorkspaceState>()
  private readonly listeners = new Map<string, Set<ProblemListener>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'problems')
    // Schemastery fills every default before plugin construction.
    this.config = config as ResolvedConfig
    for (const [name, value] of Object.entries(this.config)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`problems: config.${name} must be a positive safe integer`)
      }
    }
  }

  /**
   * Atomically replace one producer's complete contribution.
   * @param workspaceRoot - canonical Workspace path owned by the caller.
   * @param source - producer namespace to replace.
   * @param inputs - complete new contribution; empty clears the source.
   * @returns detached complete snapshot after replacement.
   */
  replace(workspaceRoot: string, source: ProblemSourceId, inputs: readonly ProblemInput[]): ProblemSnapshot {
    this.validateWorkspaceRoot(workspaceRoot)
    this.validateSource(source)
    if (inputs.length > this.config.maxProblemsPerSource) {
      throw new Error(`problems: per-source problem limit is ${this.config.maxProblemsPerSource}`)
    }
    const contribution = inputs.map(input => this.normalizeProblem(source, input)).sort(compareProblems)
    const existingState = this.workspaces.get(workspaceRoot)
    const state = existingState ?? { revision: 0, sources: new Map<ProblemSourceId, Problem[]>() }
    const previous = state.sources.get(source) ?? []
    if (sameProblems(previous, contribution)) return this.snapshot(state)

    const nextSourceCount = state.sources.size
      + (previous.length === 0 && contribution.length > 0 ? 1 : 0)
      - (previous.length > 0 && contribution.length === 0 ? 1 : 0)
    if (nextSourceCount > this.config.maxSourcesPerWorkspace) {
      throw new Error(`problems: source limit is ${this.config.maxSourcesPerWorkspace} per Workspace`)
    }
    const nextTotal = [...state.sources.entries()].reduce(
      (count, [currentSource, current]) => count + (currentSource === source ? contribution.length : current.length),
      state.sources.has(source) ? 0 : contribution.length,
    )
    if (nextTotal > this.config.maxProblemsPerWorkspace) {
      throw new Error(`problems: Workspace problem limit is ${this.config.maxProblemsPerWorkspace}`)
    }

    if (contribution.length === 0) state.sources.delete(source)
    else state.sources.set(source, contribution)
    state.revision += 1
    if (existingState === undefined) this.workspaces.set(workspaceRoot, state)
    const snapshot = this.snapshot(state)
    this.notify(workspaceRoot, snapshot)
    return snapshot
  }

  /**
   * Inspect one Workspace without creating visible state.
   * @param workspaceRoot - canonical Workspace path.
   * @returns detached complete snapshot.
   */
  inspect(workspaceRoot: string): ProblemSnapshot {
    this.validateWorkspaceRoot(workspaceRoot)
    const state = this.workspaces.get(workspaceRoot)
    return state === undefined ? { revision: 0, problems: [] } : this.snapshot(state)
  }

  /**
   * Observe complete replacement snapshots for one Workspace.
   * @param workspaceRoot - canonical Workspace path.
   * @param listener - effect-scoped contained listener.
   * @returns disposer that immediately detaches the listener.
   */
  subscribe(workspaceRoot: string, listener: ProblemListener): () => void {
    this.validateWorkspaceRoot(workspaceRoot)
    let active = true
    let listeners = this.listeners.get(workspaceRoot)
    if (listeners === undefined) {
      listeners = new Set()
      this.listeners.set(workspaceRoot, listeners)
    }
    const workspaceListeners = listeners
    workspaceListeners.add(listener)
    const detach = (): void => {
      if (!active) return
      active = false
      workspaceListeners.delete(listener)
      if (workspaceListeners.size === 0) this.listeners.delete(workspaceRoot)
    }
    const disposeEffect = this.ctx.effect(() => detach, 'problems.subscribe()')
    return () => {
      detach()
      void disposeEffect()
    }
  }

  /** Validate an internal authoritative Workspace key. */
  private validateWorkspaceRoot(workspaceRoot: string): void {
    if (workspaceRoot.trim().length === 0 || workspaceRoot.includes('\0')) {
      throw new Error('problems: workspaceRoot must be a non-empty canonical path')
    }
  }

  /** Validate the producer namespace before any state lookup or mutation. */
  private validateSource(source: ProblemSourceId): void {
    const value = String(source)
    if (value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error('problems: source must be a non-empty single-line id')
    }
    if (bytes(value) > this.config.maxSourceBytes) {
      throw new Error(`problems: source exceeds ${this.config.maxSourceBytes} UTF-8 bytes`)
    }
  }

  /** Validate and detach one producer entry. */
  private normalizeProblem(source: ProblemSourceId, input: ProblemInput): Problem {
    if (!Object.hasOwn(severityOrder, input.severity)) {
      throw new Error(`problems: unsupported severity ${JSON.stringify(input.severity)}`)
    }
    if (input.message.length === 0) throw new Error('problems: message must be non-empty')
    if (bytes(input.message) > this.config.maxMessageBytes) {
      throw new Error(`problems: message exceeds ${this.config.maxMessageBytes} UTF-8 bytes`)
    }
    if (input.code !== undefined && bytes(input.code) > this.config.maxCodeBytes) {
      throw new Error(`problems: code exceeds ${this.config.maxCodeBytes} UTF-8 bytes`)
    }
    const path = input.path === undefined ? undefined : normalizePath(input.path, this.config.maxPathBytes)
    const range = normalizeRange(input)
    return {
      severity: input.severity,
      message: input.message,
      source,
      ...path === undefined ? {} : { path },
      ...input.code === undefined ? {} : { code: input.code },
      ...range === undefined ? {} : { range },
    }
  }

  /** Flatten source contributions into one detached deterministic view. */
  private snapshot(state: WorkspaceState): ProblemSnapshot {
    const problems = [...state.sources.values()].flat().sort(compareProblems).map(copyProblem)
    return { revision: state.revision, problems }
  }

  /** Deliver one committed snapshot without allowing one listener to block another. */
  private notify(workspaceRoot: string, snapshot: ProblemSnapshot): void {
    for (const listener of this.listeners.get(workspaceRoot) ?? []) {
      try {
        const result = listener({ revision: snapshot.revision, problems: snapshot.problems.map(copyProblem) })
        void Promise.resolve(result).catch((error: unknown) => {
          this.ctx.logger.warn(`problems: listener rejected: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`problems: listener threw: ${String(error)}`)
      }
    }
  }
}

export default Problems
