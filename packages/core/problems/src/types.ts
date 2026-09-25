/** Browser-safe types for the Workspace Problems capability. @module @deepseek-ai/dsh-problems/types */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable producer namespace inside one Workspace problem snapshot. */
export type ProblemSourceId = Branded<'ProblemSourceId'>

/**
 * Brand a validated producer namespace. Validation occurs when a producer replaces its contribution.
 * @param value - producer namespace.
 * @returns the unchanged branded string.
 */
export function ProblemSourceId(value: string): ProblemSourceId {
  return value as ProblemSourceId
}

/** User-facing diagnostic severity ordered from most to least urgent. */
export type ProblemSeverity = 'error' | 'warning' | 'info' | 'hint'

/** One-based source position. */
export interface ProblemPosition {
  /** One-based line. */
  line: number
  /** One-based column. */
  column: number
}

/** Source range whose optional end uses standard exclusive-position semantics. */
export interface ProblemRange {
  /** Inclusive start position. */
  start: ProblemPosition
  /** Optional exclusive end position, which cannot precede {@link start}. */
  end?: ProblemPosition
}

/** Producer input; the registry supplies the source being replaced. */
export interface ProblemInput {
  /** Urgency used for counts and ordering. */
  severity: ProblemSeverity
  /** Human-readable diagnostic text. */
  message: string
  /** Optional Workspace-relative file path. */
  path?: string
  /** Optional source range; requires {@link path}. */
  range?: ProblemRange
  /** Optional producer-owned diagnostic code. */
  code?: string
}

/** Validated problem returned to consumers. */
export interface Problem extends ProblemInput {
  /** Producer namespace that owns replacement and clearing. */
  source: ProblemSourceId
}

/** Complete immutable-by-convention view for one canonical Workspace. */
export interface ProblemSnapshot {
  /** Monotonic visible-state revision; zero means no contribution has been committed. */
  revision: number
  /** Deterministically ordered detached problems from every active source. */
  problems: Problem[]
}

/** Full-snapshot listener used by Host consumers. */
export type ProblemListener = (snapshot: ProblemSnapshot) => void | PromiseLike<void>
