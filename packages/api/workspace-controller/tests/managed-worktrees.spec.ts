/** Managed-worktree creation, ownership resolution, and safety-checked removal against real Git repositories. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  vi.restoreAllMocks()
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
async function managed(overrides: Partial<ManagedWorktreeConfig> = {}, configure?: (ctx: Context) => void): Promise<ManagedWorktrees> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(LocalSubprocessRuntime)
  configure?.(ctx)
  const directory = await scratchDir('dsh-managed-worktree-store-')
  const config: ManagedWorktreeConfig = {
    managedWorktreeDirectory: directory, gitTimeoutMs: 30_000, gitGraceMs: 2_000, maxOutputBytes: 1024 * 1024,
    ...overrides,
  }
  return new ManagedWorktrees(ctx, config)
}

describe('ManagedWorktrees.create', () => {
  it('requires an absolute managed directory and local filesystem mapping', async () => {
    await expect(managed({ managedWorktreeDirectory: 'relative' })).rejects.toThrow('must be absolute')
    const worktrees = await managed({}, (ctx) => {
      vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
    })
    await expect(worktrees.create(await repository())).rejects.toThrow('local filesystem')
  })

  it('refuses storage inside the source repository', async () => {
    const source = await repository()
    const worktrees = await managed({ managedWorktreeDirectory: join(source, 'managed') })
    await expect(worktrees.create(source)).rejects.toThrow('outside every source checkout')
  })

  it('retains recovery metadata when Git cannot create the checkout', async () => {
    const source = await repository()
    const directory = await scratchDir('dsh-managed-worktree-recovery-')
    const worktrees = await managed({ managedWorktreeDirectory: directory })
    const run = worktrees.git.bind(worktrees)
    vi.spyOn(worktrees, 'git').mockImplementation((cwd, args) => args[0] === 'worktree'
      ? Promise.reject(new Error('disk full')) : run(cwd, args))
    await expect(worktrees.create(source)).rejects.toThrow('recovery metadata retained')
    const owners = await readdir(directory)
    expect(owners).toHaveLength(1)
    expect(JSON.parse(await readFile(join(directory, owners[0]!, 'worktree.json'), 'utf8'))).toMatchObject({ state: 'creating', source })
  })

  it('disables required clean and smudge filters while creating and inspecting checkouts', async () => {
    const source = await repository()
    await writeFile(join(source, '.gitattributes'), '*.txt filter=fixture\n')
    git(source, 'add', '.gitattributes')
    git(source, 'commit', '-q', '-m', 'attributes')
    for (const name of ['clean', 'smudge', 'process']) git(source, 'config', `filter.fixture.${name}`, 'exit 99')
    git(source, 'config', 'filter.fixture.required', 'true')
    const worktrees = await managed()
    const record = await worktrees.create(source)
    expect(await readFile(join(record.path, 'f.txt'), 'utf8')).toBe('base\n')
    await worktrees.remove(record)
  })

  it('rejects truncated Git output and a deadline reached before completion', async () => {
    const source = await repository()
    const limited = await managed({ maxOutputBytes: 1 })
    await expect(limited.git(source, ['--version'])).rejects.toThrow('output exceeded its limit')
    const aborter = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(aborter.signal)
    const timed = await managed({}, (ctx) => {
      vi.spyOn(ctx.subprocess, 'resolveExecutable').mockResolvedValue('git')
      vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => ({
        done: Promise.resolve().then(() => { aborter.abort(); return { exitCode: 0, signal: null } }),
      } as never))
    })
    await expect(timed.git(source, ['--version'])).rejects.toThrow('timed out or was aborted')
  })

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
  it.each(['null', 'text', 'empty', 'missing', 'directory', 'oversized', 'other-path', 'other-branch', 'symlink'] as const)(
    'rejects or ignores %s ownership metadata without changing the checkout', async (state) => {
      const source = await repository()
      const worktrees = await managed()
      const record = await worktrees.create(source)
      const manifest = join(dirname(record.path), 'worktree.json')
      if (state === 'missing' || state === 'directory') {
        await unlink(manifest)
        if (state === 'directory') await mkdir(manifest)
      } else if (state === 'oversized') await writeFile(manifest, 'x'.repeat(1024 * 1024 + 1))
      else if (state === 'other-branch') git(record.path, 'switch', '-q', '-c', 'replacement')
      else if (state === 'symlink') {
        const moved = join(dirname(record.path), 'moved')
        await rename(record.path, moved)
        await symlink(moved, record.path, 'junction')
      } else await writeFile(manifest, JSON.stringify(state === 'null' ? null : state === 'text' ? 'foreign'
        : state === 'empty' ? {} : { ...record, path: source }))
      if (state === 'missing' || state === 'other-path') await expect(worktrees.get(record.path)).resolves.toBeUndefined()
      else await expect(worktrees.get(record.path)).rejects.toThrow()
    },
  )

  it('ignores lookalike paths outside storage and unavailable storage roots', async () => {
    const directory = await scratchDir('dsh-managed-worktree-lookalike-')
    const worktrees = await managed()
    const path = join(directory, '00000000-0000-0000-0000-000000000000', 'files')
    await expect(worktrees.get(path)).resolves.toBeUndefined()
    const file = join(directory, 'not-directory')
    await writeFile(file, 'file')
    const unavailable = await managed({ managedWorktreeDirectory: join(file, 'nested') })
    await expect(unavailable.get(path)).resolves.toBeUndefined()
  })

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
