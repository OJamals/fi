/** Per-turn workspace change summaries, the Session event announcing them, and the Host service serving them with their comparisons. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One file changed during a turn, with line counts from git or from the whole-file captures around its file-tool edits. */
export interface WorkspaceChangedFile {
  /** Path relative to the Session working directory, or an absolute Host path outside it. */
  path: string
  /**
   * Sort key and label: the relative path inside the working directory, a
   * `../` path for repository files above it, a `~` path under the home
   * directory, otherwise the absolute path. Always slash-separated.
   */
  display: string
  /** Lines added; zero for a binary or oversized file. */
  added: number
  /** Lines deleted; zero for a binary or oversized file. */
  deleted: number
  /** Present when git reported the file as binary, or when a captured side holds a NUL byte. */
  binary?: true
  /** Present when a captured side exceeded the plugin's `maxFileBytes`; the file is listed without counts or comparison. */
  oversized?: true
}

/** Files changed during one top-level turn, kept on the Host until its Session is disposed. */
export interface WorkspaceChangesSummary {
  /** The turn whose file changes this summary describes. */
  turn: number
  /** The Session working directory `path` values are relative to. */
  cwd: string
  /** Changed files in `display` order, capped at the plugin's `maxFiles`. */
  files: WorkspaceChangedFile[]
  /** Complete changed-file count, including files omitted by the cap. */
  total: number
  /** Lines added over every changed file, including files omitted by the cap. */
  added: number
  /** Lines deleted over every changed file, including files omitted by the cap. */
  deleted: number
  /** Git tree ids of the turn-start and turn-end snapshots; absent when no snapshot was taken. */
  snapshot?: { before: string; after: string }
}

/** One unified-diff hunk with three context lines; every line keeps its `+`, `-`, or space prefix. */
export interface WorkspaceDiffHunk {
  /** First line of the hunk in the turn-start content, 1-based; a side without lines starts at 1 with zero lines. */
  oldStart: number
  /** Lines of the hunk taken from the turn-start content. */
  oldLines: number
  /** First line of the hunk in the turn-end content, 1-based; a side without lines starts at 1 with zero lines. */
  newStart: number
  /** Lines of the hunk taken from the turn-end content. */
  newLines: number
  /** Hunk body in order, each line prefixed with `+`, `-`, or a space. */
  lines: string[]
}

/** The comparison of one listed file's turn-start and turn-end contents, computed when asked for. */
export type WorkspaceFileDiff =
  | {
    kind: 'text'
    /** The listed file's `path`. */
    path: string
    /** The listed file's `display`. */
    display: string
    /** Whether the file existed at turn start. */
    before: boolean
    /** Whether the file existed at turn end. */
    after: boolean
    /** Hunks in file order; empty when both sides hold the same lines. */
    hunks: WorkspaceDiffHunk[]
    /** True when the line comparison exceeded the plugin's `diffTimeoutMs` and every line is shown as replaced. */
    coarse: boolean
  }
  /** A side git reported as binary or that holds a NUL byte; no lines are served. */
  | { kind: 'binary'; path: string; display: string }
  /** A side larger than the plugin's `maxFileBytes`; no lines are served. */
  | { kind: 'oversized'; path: string; display: string }

/** Which captured side of a listed file a restore writes back to disk. */
export type WorkspaceRestoreSide = 'before' | 'after'

/** The outcome of one restore attempt. */
export type WorkspaceRestoreResult =
  /** The requested side's content is now on disk. */
  | { kind: 'restored' }
  /** A side git reported as binary or that holds a NUL byte; no restore is possible. */
  | { kind: 'binary' }
  /** A side larger than the plugin's `maxFileBytes`; no restore is possible. */
  | { kind: 'oversized' }
  /**
   * The live file no longer holds the opposite side's content, so restoring
   * would discard an edit this summary never observed; nothing was written.
   */
  | { kind: 'diverged' }

/** Serves the summaries, file comparisons, and restores the recorder keeps for live Sessions. */
export interface WorkspaceChanges {
  /**
   * The summary announced by one `workspace/changes` event.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @returns the summary, or undefined once its Session was disposed or when this Host never recorded it.
   */
  summary(sessionId: SessionId, seq: number): WorkspaceChangesSummary | undefined
  /**
   * Compare one listed file's contents at turn start and turn end.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @param index - the file's index in the summary's `files`.
   * @param signal - cancels the reads.
   * @returns the comparison, or undefined once its Session was disposed, when this Host never recorded it, or when no file has that index.
   * @throws when a snapshot read fails for a live Session.
   */
  diff(sessionId: SessionId, seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined>
  /**
   * Write one listed file's turn-start or turn-end content back to its live path, refusing when the live
   * file no longer holds the opposite side's content.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @param index - the file's index in the summary's `files`.
   * @param side - the captured side to restore.
   * @param signal - cancels the reads.
   * @returns the outcome, or undefined once its Session was disposed, when this Host never recorded it, or when no file has that index.
   * @throws when a snapshot read or the live write fails for a live Session.
   */
  restore(
    sessionId: SessionId, seq: number, index: number, side: WorkspaceRestoreSide, signal: AbortSignal,
  ): Promise<WorkspaceRestoreResult | undefined>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A completed top-level turn's changed files were summarized; the summary itself stays on the
     * Host and is served by `workspaceChanges.summary` for the event's sequence while the Session
     * lives. The latest event for one turn replaces earlier ones.
     */
    'workspace/changes': { turn: number }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-turn changed-file summaries and comparisons of live Sessions. */
    workspaceChanges: WorkspaceChanges
  }
}
