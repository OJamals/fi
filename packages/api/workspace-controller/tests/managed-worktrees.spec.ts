/** Managed-worktree creation, ownership resolution, and safety-checked removal against real Git repositories. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ManagedWorktrees, type ManagedWorktreeConfig } from '../src/managed-worktrees.ts'

/** Run git synchronously inside a fixture repository. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A temporary directory removed by the test's cleanup. */
async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A repository fixture with one committed file, at its canonical (symlink-resolved) path. */
async function repository(): Promise<string> {
  const cwd = await scratchDir('dsh-managed-worktree-src-')
  git(cwd, 'init', '-q', '-b', 'main')
  await writeFile(join(cwd, 'f.txt'), 'base\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'base')
  // macOS tmpdir() is under /var, itself a symlink to /private/var; ManagedWorktrees
  // always canonicalizes, so the fixture must compare against the same canonical form.
  return realpath(cwd)
}

/** A composed Context with the local FS and subprocess providers this class requires. */
async function managed(overrides: Partial<ManagedWorktreeConfig> = {}): Promise<ManagedWorktrees> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(LocalSubprocessRuntime)
  const directory = await scratchDir('dsh-managed-worktree-store-')
  const config: ManagedWorktreeConfig = {
    managedWorktreeDirectory: directory, gitTimeoutMs: 30_000, gitGraceMs: 2_000, maxOutputBytes: 1024 * 1024,
    ...overrides,
  }
  return new ManagedWorktrees(ctx, config)
}

describe('ManagedWorktrees.create', () => {
  it('creates an isolated checkout at the committed HEAD on a fresh branch, outside the source checkout', async () => {
    const source = await repository()
    const worktrees = await managed()
    const record = await worktrees.create(source)
    expect(record.state).toBe('ready')
    expect(record.source).toBe(source)
    expect(record.branch).toMatch(/^fi\/session-/)
    expect(dirname(record.path)).not.toBe(source)
    expect(await readFile(join(record.path, 'f.txt'), 'utf8')).toBe('base\n')
    // The checkout is on its own branch, not the source's checked-out branch.
    expect(git(record.path, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(record.branch)
  })

  it('does not copy the source checkout\'s uncommitted, staged, or untracked files', async () => {
    const source = await repository()
    await writeFile(join(source, 'f.txt'), 'dirty\n')
    await writeFile(join(source, 'untracked.txt'), 'new\n')
    const worktrees = await managed()
    const record = await worktrees.create(source)
    expect(await readFile(join(record.path, 'f.txt'), 'utf8')).toBe('base\n')
    await expect(readFile(join(record.path, 'untracked.txt'), 'utf8')).rejects.toThrow()
    // The source checkout itself is untouched.
    expect(await readFile(join(source, 'f.txt'), 'utf8')).toBe('dirty\n')
    expect(git(source, 'status', '--porcelain').trim()).not.toBe('')
  })

  it('refuses a source that is not a repository root', async () => {
    const source = await repository()
    const nested = join(source, 'nested')
    await mkdir(nested)
    const worktrees = await managed()
    await expect(worktrees.create(nested)).rejects.toThrow('repository-root')
  })

  it('refuses a source with no commit', async () => {
    const source = await scratchDir('dsh-managed-worktree-unborn-')
    git(source, 'init', '-q', '-b', 'main')
    const worktrees = await managed()
    await expect(worktrees.create(source)).rejects.toThrow()
  })
})

describe('ManagedWorktrees.get', () => {
  it('resolves ready ownership from the checkout path', async () => {
    const source = await repository()
    const worktrees = await managed()
    const record = await worktrees.create(source)
    const resolved = await worktrees.get(record.path)
    expect(resolved).toEqual(record)
  })

  it('reports undefined for an ordinary directory shaped like a checkout', async () => {
    const worktrees = await managed()
    const ordinary = await scratchDir('dsh-managed-worktree-ordinary-')
    expect(await worktrees.get(ordinary)).toBeUndefined()
    expect(await worktrees.get(join(ordinary, 'files'))).toBeUndefined()
  })

  it('reports undefined once a checkout has been removed', async () => {
    const source = await repository()
    const worktrees = await managed()
    const record = await worktrees.create(source)
    await worktrees.remove(record)
    expect(await worktrees.get(record.path)).toBeUndefined()
  })
})

describe('ManagedWorktrees.remove', () => {
  it('removes a clean, unmodified checkout and its branch registration from the source', async () => {
    const source = await repository()
    const worktrees = await managed()
    const record = await worktrees.create(source)
    await worktrees.remove(record)
    await expect(readFile(join(record.path, 'f.txt'), 'utf8')).rejects.toThrow()
    expect(git(source, 'worktree', 'list', '--porcelain')).not.toContain(record.path)
    // The branch itself is retained, per the documented "retain its branch" contract.
    expect(git(source, 'branch', '--list', record.branch).trim()).not.toBe('')
  })

  it('refuses removal while the checkout has uncommitted changes', async () => {
    const source = await repository()
    const worktrees = await managed()
    const record = await worktrees.create(source)
    await writeFile(join(record.path, 'f.txt'), 'edited\n')
    await expect(worktrees.remove(record)).rejects.toThrow('clean worktree')
    // The worktree is retained after a refused removal.
    expect(await readFile(join(record.path, 'f.txt'), 'utf8')).toBe('edited\n')
  })

  it('refuses removal while the checkout has untracked files', async () => {
    const source = await repository()
    const worktrees = await managed()
    const record = await worktrees.create(source)
    await writeFile(join(record.path, 'new.txt'), 'new\n')
    await expect(worktrees.remove(record)).rejects.toThrow('clean worktree')
  })

  it('refuses removal of commits not yet merged into the source', async () => {
    const source = await repository()
    const worktrees = await managed()
    const record = await worktrees.create(source)
    await writeFile(join(record.path, 'f.txt'), 'ahead\n')
    git(record.path, 'commit', '-q', '-am', 'ahead of source')
    await expect(worktrees.remove(record)).rejects.toThrow()
    expect(git(source, 'worktree', 'list', '--porcelain')).toContain(record.path)
  })

  it('removes a checkout whose commits were fast-forwarded into the source', async () => {
    const source = await repository()
    const worktrees = await managed()
    const record = await worktrees.create(source)
    await writeFile(join(record.path, 'f.txt'), 'merged\n')
    git(record.path, 'commit', '-q', '-am', 'merged into source')
    git(source, 'merge', '-q', '--ff-only', record.branch)
    await worktrees.remove(record)
    expect(git(source, 'worktree', 'list', '--porcelain')).not.toContain(record.path)
  })
})
