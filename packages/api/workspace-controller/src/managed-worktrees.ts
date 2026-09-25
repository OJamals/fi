/**
 * Local Git worktrees created for a registered Workspace's repository. Each
 * checkout is registered as an ordinary Workspace (Session cwd stays the one
 * authority for tools, search, and Git inspection), while its application
 * ownership record — source, branch, base commit, lifecycle state — lives
 * beside the checkout rather than inside it, so `git worktree remove`
 * deleting the checkout directory never loses that record.
 */
import { mkdir, open, realpath, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { readManifestBytes } from './worktree-storage.ts'

/** Deployment policy for locally managed worktrees. */
export interface ManagedWorktreeConfig {
  /** Absolute directory outside every source repository that retains checkouts and their ownership records. */
  readonly managedWorktreeDirectory: string
  /** Milliseconds one git command may run before it is aborted. */
  readonly gitTimeoutMs: number
  /** Milliseconds a terminated git process gets to exit before it is killed. */
  readonly gitGraceMs: number
  /** Bytes of git output retained per command, and the byte limit its ownership manifest read is bounded to. */
  readonly maxOutputBytes: number
}

/**
 * Schemastery validation for {@link ManagedWorktreeConfig}, resolved
 * explicitly by the owning `WorkspaceController` only when its caller
 * supplies the block at all. Every `z.object()` schema resolves an absent
 * value against an implicit `{}` default rather than staying absent, which
 * would otherwise throw on `managedWorktreeDirectory`'s required field for
 * every composition that does not configure this feature; resolving it
 * conditionally in plain code, instead of nesting it inside a larger
 * optional schema, keeps the block genuinely optional.
 */
export const ManagedWorktreeConfigSchema: z<ManagedWorktreeConfig, Required<ManagedWorktreeConfig>> = z.object({
  managedWorktreeDirectory: z.string().required(),
  gitTimeoutMs: z.natural().min(1).default(30_000),
  gitGraceMs: z.natural().min(1).default(2_000),
  maxOutputBytes: z.natural().min(1).default(8 * 1024 * 1024),
})

/** Durable application-ownership record for one managed worktree. */
export interface ManagedWorktree {
  readonly version: 1
  /** Canonical path of the source Workspace this checkout isolates. */
  readonly source: string
  /** Canonical path of the checkout itself (the registered Workspace's directory). */
  readonly path: string
  /** The unique branch `git worktree add` created. */
  readonly branch: string
  /** The source commit the checkout started from. */
  readonly base: string
  readonly state: 'creating' | 'ready' | 'removed'
}

/** Whether a filesystem error names a missing path. */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Runtime validation for the on-disk manifest: a durable/file boundary a
 * damaged or foreign-written file can violate even though every writer here
 * is typed.
 * @param value - decoded JSON.
 * @returns whether `value` is a complete {@link ManagedWorktree} record.
 */
function isManagedWorktree(value: unknown): value is ManagedWorktree {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.version === 1
    && typeof record.source === 'string' && record.source !== ''
    && typeof record.path === 'string' && record.path !== ''
    && typeof record.branch === 'string' && record.branch !== ''
    && typeof record.base === 'string' && /^[a-f0-9]{40,64}$/.test(record.base as string)
    && (record.state === 'creating' || record.state === 'ready' || record.state === 'removed')
}

/** The manifest path colocated beside (never inside) a managed checkout. */
function manifestPath(checkoutPath: string): string {
  return join(dirname(checkoutPath), 'worktree.json')
}

/**
 * Creates and removes local Git worktrees outside their source checkout,
 * with application ownership resolved from the checkout's own path shape and
 * its colocated manifest rather than from a caller-supplied identity.
 */
export class ManagedWorktrees {
  /**
   * @param ctx - Host context supplying `fs` and `subprocess`.
   * @param config - local storage directory and bounded git execution policy.
   */
  constructor(private readonly ctx: Context, private readonly config: ManagedWorktreeConfig) {
    if (!isAbsolute(config.managedWorktreeDirectory)) throw new Error('managedWorktreeDirectory must be absolute')
  }

  /**
   * Create an isolated checkout of `source` at its committed HEAD. Uncommitted changes in `source` are not
   * copied: `git worktree` semantics apply, so the checkout reflects committed history alone.
   * @param source - a registered Workspace's directory; must be a repository root.
   * @returns the new checkout's durable ownership record, with `state: 'ready'`.
   * @throws when the Host filesystem or subprocess world is not local, `source` is not a repository root,
   * the managed-worktree directory cannot be created outside `source`, or `git worktree add` fails.
   */
  async create(source: string): Promise<ManagedWorktree> {
    this.requireLocal(source)
    const canonicalSource = await realpath(source)
    const root = (await this.git(canonicalSource, ['rev-parse', '--show-toplevel'])).trim()
    if (await realpath(root) !== canonicalSource) {
      throw new Error('A managed worktree requires a repository-root Workspace')
    }
    const base = (await this.git(canonicalSource, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    const directory = await this.canonicalManagedDirectory()
    this.requireOutside(canonicalSource, directory)
    const owner = join(directory, randomUUID())
    await mkdir(owner, { recursive: true, mode: 0o700 })
    const path = join(owner, 'files')
    const branch = `fi/session-${basename(owner)}`
    let record: ManagedWorktree = { version: 1, source: canonicalSource, path, branch, base, state: 'creating' }
    await this.save(record)
    try {
      await this.git(canonicalSource, ['worktree', 'add', '-b', branch, path, base])
    } catch (error) {
      // The manifest already names the branch and path git may have partly created; nothing is cleaned up
      // automatically, so a failed creation stays inspectable instead of silently disappearing.
      throw new Error(`managed worktree creation failed; recovery metadata retained at "${owner}"`, { cause: error })
    }
    record = { ...record, state: 'ready' }
    await this.save(record)
    return record
  }

  /**
   * Resolve application ownership of an existing checkout from its own path shape and colocated manifest.
   * @param path - a Session or Workspace directory to test; never trusted as ownership on its own.
   * @returns the ready record, or undefined for a path this class does not own.
   * @throws when the path has the owned shape but its manifest is missing, unreadable, corrupt, or names
   * a branch or state the checkout itself no longer matches.
   */
  async get(path: string): Promise<ManagedWorktree | undefined> {
    if (basename(path) !== 'files' || !/^[0-9a-f-]{36}$/.test(basename(dirname(path)))) return undefined
    const directory = await this.canonicalManagedDirectory().catch(() => undefined)
    if (directory === undefined || dirname(dirname(path)) !== directory) return undefined
    let bytes: Buffer
    try {
      bytes = await readManifestBytes(manifestPath(path), this.config.maxOutputBytes)
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (!isManagedWorktree(parsed)) throw new Error(`managed worktree manifest is corrupt: "${manifestPath(path)}"`)
    if (parsed.path !== path || parsed.state !== 'ready') return undefined
    this.requireLocal(path)
    if (await realpath(path) !== path) throw new Error('managed worktree path changed since creation')
    const branch = (await this.git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
    if (branch !== parsed.branch) throw new Error('managed worktree branch changed since creation')
    return parsed
  }

  /**
   * Remove a checkout whose worktree is clean (including ignored files) and whose HEAD is already reachable
   * from its source's current HEAD, so nothing unique to the checkout is ever discarded. Its branch, the
   * source repository, and every Session log stay untouched.
   * @param record - a record {@link get} just resolved.
   * @throws when the checkout has uncommitted or ignored content, unmerged commits, or `git worktree remove` fails.
   */
  async remove(record: ManagedWorktree): Promise<void> {
    const status = await this.git(record.path, ['status', '--porcelain', '--untracked-files=all', '--ignored'])
    if (status !== '') throw new Error('managed worktree removal requires a clean worktree, including ignored files')
    const head = (await this.git(record.path, ['rev-parse', 'HEAD'])).trim()
    await this.git(record.source, ['merge-base', '--is-ancestor', head, 'HEAD'])
      .catch((error: unknown) => { throw new Error('managed worktree has commits not reachable from its source', { cause: error }) })
    await this.git(record.source, ['worktree', 'remove', record.path])
    await this.save({ ...record, state: 'removed' })
  }

  /**
   * Run one bounded git command through the composed subprocess provider, with repository hooks, the
   * filesystem watcher, and (for `status` and `worktree` commands) every clean/smudge/process content
   * filter disabled — a filter is arbitrary repository-configured execution, and these commands must not
   * run it just to snapshot or mutate a checkout.
   * @param cwd - a local repository or checkout path.
   * @param args - literal git arguments; never shell-interpreted.
   * @returns complete trimmed-free stdout.
   * @throws when git cannot be resolved, the command times out or is aborted, or it exits non-zero.
   */
  async git(cwd: string, args: readonly string[]): Promise<string> {
    if (args[0] !== 'status' && args[0] !== 'worktree') return this.runGit(cwd, args)
    const keys = await this.runGit(cwd, ['config', '--null', '--name-only', '--list'])
    const filters = keys.split('\0').filter(key => /^filter\..*\.(clean|smudge|process|required)$/i.test(key))
      .flatMap(key => ['-c', `${key}=${/\.required$/i.test(key) ? 'false' : ''}`])
    return this.runGit(cwd, [...filters, ...args])
  }

  private async runGit(cwd: string, args: readonly string[]): Promise<string> {
    const signal = AbortSignal.timeout(this.config.gitTimeoutMs)
    const executable = await this.ctx.subprocess.resolveExecutable('git', undefined, signal)
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${join(this.config.managedWorktreeDirectory, 'disabled-hooks')}`, '-C', cwd, ...args],
      cwd,
      signal,
      graceMs: this.config.gitGraceMs,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.maxOutputBytes },
        stderr: { maxBytes: this.config.maxOutputBytes },
      },
      env: { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    })
    const outcome = await handle.done
    if (signal.aborted) throw new Error(`git ${args.join(' ')} timed out or was aborted`)
    /* v8 ignore start -- collect-mode stdio always yields both readers. */
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    /* v8 ignore stop */
    if (stdout.lossy) throw new Error(`git ${args.join(' ')} output exceeded its limit`)
    if (outcome.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)
    return stdout.text
  }

  /** Refuse an operation the composed `fs`/`subprocess` world cannot guarantee acts on this literal Host path. */
  private requireLocal(path: string): void {
    if (this.ctx.fs.processPathFromHostPath(path) !== path) {
      throw new Error('managed worktrees require a local filesystem and subprocess execution world')
    }
  }

  /** Refuse a managed-worktree directory that resolves inside the source checkout it must isolate from. */
  private requireOutside(source: string, directory: string): void {
    const relativeDirectory = relative(source, directory)
    if (relativeDirectory === '' || (!isAbsolute(relativeDirectory) && relativeDirectory !== '..' && !relativeDirectory.startsWith(`..${sep}`))) {
      throw new Error('managed worktrees must be stored outside every source checkout')
    }
    this.requireLocal(directory)
  }

  /** The managed-worktree root, created and canonicalized once its existing ancestor is confirmed local. */
  private async canonicalManagedDirectory(): Promise<string> {
    await mkdir(this.config.managedWorktreeDirectory, { recursive: true, mode: 0o700 })
    return realpath(this.config.managedWorktreeDirectory)
  }

  private async save(record: ManagedWorktree): Promise<void> {
    const destination = manifestPath(record.path)
    const temporary = `${destination}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, destination)
  }
}
