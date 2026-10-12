/** Restoring a listed file's turn-start or turn-end content back to its live path. */
import { mkdir, readFile, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as WorkspaceChanges from '../src/index.ts'
import { endTurn, git, mutate, scratchDir, settle, startTurn, toolCall } from './support.ts'

const { beforeUnlink } = vi.hoisted(() => ({ beforeUnlink: vi.fn<(path: import('node:fs').PathLike) => Promise<void>>() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, unlink: async (path: import('node:fs').PathLike) => {
    await beforeUnlink(path)
    return actual.unlink(path)
  } }
})

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
  beforeUnlink.mockReset()
})

const signal = new AbortController().signal

async function boot(config: Partial<WorkspaceChanges.Config> = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(WorkspaceChanges, config as WorkspaceChanges.Config)
  return { ctx }
}

async function repository(): Promise<string> {
  const cwd = await scratchDir('dsh-workspace-changes-restore-', cleanups)
  git(cwd, 'init', '-q', '-b', 'main')
  await writeFile(join(cwd, 'a.txt'), 'l1\nl2\nl3\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'init')
  return cwd
}

function announcedSeq(session: Session): number {
  const event = session.snapshotEvents().filter(event => event.type === 'workspace/changes').at(-1)
  if (event === undefined) throw new Error('no workspace/changes announcement')
  return event.seq
}

describe('workspace-changes restore', () => {
  it.each(['before', 'after'] as const)('refuses oversized snapshot content on the %s side', async (side) => {
    const cwd = await repository()
    const path = join(cwd, 'a.txt')
    if (side === 'before') await writeFile(path, 'x'.repeat(65))
    const { ctx } = await boot({ maxFileBytes: 64 })
    const session = ctx.sessions.create(SessionId(`restore-large-snapshot-${side}`), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await writeFile(path, side === 'after' ? 'x'.repeat(65) : 'small')
    toolCall(session, 1, 'bash', { command: 'edit a.txt' })
    endTurn(session, 1)
    await settle(ctx, session)
    await expect(ctx.workspaceChanges.restore(session.id, announcedSeq(session), 0, 'before', signal))
      .resolves.toEqual({ kind: 'oversized' })
    await expect(readFile(path, 'utf8')).resolves.toBe(side === 'after' ? 'x'.repeat(65) : 'small')
  })

  it.each(['missing', 'directory'] as const)('handles a new file becoming %s immediately before restore removes it', async (state) => {
    const cwd = await repository()
    const path = join(cwd, 'new.txt')
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId(`restore-unlink-${state}`), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'new.txt', content: 'new' }, () => writeFile(path, 'new'))
    endTurn(session, 1)
    await settle(ctx, session)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    beforeUnlink.mockImplementationOnce(async (target) => {
      expect(target).toBe(await realpath(path))
      await actual.unlink(path)
      if (state === 'directory') await mkdir(path)
    })
    const restoring = ctx.workspaceChanges.restore(session.id, announcedSeq(session), 0, 'before', signal)
    if (state === 'missing') {
      await expect(restoring).resolves.toEqual({ kind: 'restored' })
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await expect(restoring).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|EPERM)$/) as string })
      expect((await stat(path)).isDirectory()).toBe(true)
    }
  })

  it.each(['missing', 'directory', 'oversized', 'unreadable'] as const)(
    'refuses replacing a target that became %s after the turn', async (state) => {
      const cwd = await repository()
      const { ctx } = await boot({ maxFileBytes: 64 })
      const session = ctx.sessions.create(SessionId(`restore-${state}`), { meta: { cwd } })
      startTurn(session, 1)
      await settle(ctx, session)
      const path = join(cwd, 'a.txt')
      await mutate(ctx, session, 1, 'write', { file_path: 'a.txt', content: 'changed' }, () => writeFile(path, 'changed'))
      endTurn(session, 1)
      await settle(ctx, session)
      await unlink(path)
      if (state === 'directory') await mkdir(path)
      if (state === 'oversized') await writeFile(path, 'x'.repeat(65))
      if (state === 'unreadable') await symlink(path, path)
      const restoring = ctx.workspaceChanges.restore(session.id, announcedSeq(session), 0, 'before', signal)
      if (state === 'unreadable') await expect(restoring).rejects.toMatchObject({ code: 'ELOOP' })
      else await expect(restoring).resolves.toEqual({ kind: state === 'missing' ? 'diverged' : 'oversized' })
    },
  )

  it('settles an in-flight restore when its session is disposed', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('restore-disposed-during-read'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'a.txt', content: 'changed' },
      () => writeFile(join(cwd, 'a.txt'), 'changed'))
    endTurn(session, 1)
    await settle(ctx, session)
    const restoring = ctx.workspaceChanges.restore(session.id, announcedSeq(session), 0, 'before', signal)
    ctx.emit('session/disposed', session)
    await expect(restoring).resolves.toBeUndefined()
  })

  it('restores a listed file to its turn-start content', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('restore-before'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'edit', { file_path: 'a.txt', old_string: 'l2', new_string: 'l2 model' },
      () => writeFile(join(cwd, 'a.txt'), 'l1\nl2 model\nl3\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    const seq = announcedSeq(session)

    const result = await ctx.workspaceChanges.restore(session.id, seq, 0, 'before', signal)
    expect(result).toEqual({ kind: 'restored' })
    await expect(readFile(join(cwd, 'a.txt'), 'utf8')).resolves.toBe('l1\nl2\nl3\n')
  })

  it('restores a listed file to its turn-end content after a manual revert', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('restore-after'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'edit', { file_path: 'a.txt', old_string: 'l2', new_string: 'l2 model' },
      () => writeFile(join(cwd, 'a.txt'), 'l1\nl2 model\nl3\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    const seq = announcedSeq(session)
    // The user (or an external editor) reverts the file by hand, back to the turn-start content.
    await writeFile(join(cwd, 'a.txt'), 'l1\nl2\nl3\n')

    const result = await ctx.workspaceChanges.restore(session.id, seq, 0, 'after', signal)
    expect(result).toEqual({ kind: 'restored' })
    await expect(readFile(join(cwd, 'a.txt'), 'utf8')).resolves.toBe('l1\nl2 model\nl3\n')
  })

  it('deletes a file whose turn-start side was absent', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('restore-created'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'new.txt', content: 'n1\n' },
      () => writeFile(join(cwd, 'new.txt'), 'n1\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    const seq = announcedSeq(session)

    const result = await ctx.workspaceChanges.restore(session.id, seq, 0, 'before', signal)
    expect(result).toEqual({ kind: 'restored' })
    await expect(stat(join(cwd, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a restore once the live file no longer matches the opposite side', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('restore-diverged'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'edit', { file_path: 'a.txt', old_string: 'l2', new_string: 'l2 model' },
      () => writeFile(join(cwd, 'a.txt'), 'l1\nl2 model\nl3\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    const seq = announcedSeq(session)
    // A later, unrelated edit changes the file again; restoring to turn-start would silently discard it.
    await writeFile(join(cwd, 'a.txt'), 'l1\nl2 model\nl3\nl4 later\n')

    const result = await ctx.workspaceChanges.restore(session.id, seq, 0, 'before', signal)
    expect(result).toEqual({ kind: 'diverged' })
    await expect(readFile(join(cwd, 'a.txt'), 'utf8')).resolves.toBe('l1\nl2 model\nl3\nl4 later\n')
  })

  it('refuses a restore of a binary file', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('restore-binary'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'bin.dat', content: 'ignored' },
      () => writeFile(join(cwd, 'bin.dat'), Uint8Array.of(0, 1, 2, 255)))
    endTurn(session, 1)
    await settle(ctx, session)
    const seq = announcedSeq(session)

    const result = await ctx.workspaceChanges.restore(session.id, seq, 0, 'before', signal)
    expect(result).toEqual({ kind: 'binary' })
  })

  it('returns undefined for an unknown sequence, an unknown index, and a disposed Session', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('restore-unknown'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'edit', { file_path: 'a.txt', old_string: 'l2', new_string: 'l2 model' },
      () => writeFile(join(cwd, 'a.txt'), 'l1\nl2 model\nl3\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    const seq = announcedSeq(session)

    await expect(ctx.workspaceChanges.restore(session.id, seq + 1000, 0, 'before', signal)).resolves.toBeUndefined()
    await expect(ctx.workspaceChanges.restore(session.id, seq, 5, 'before', signal)).resolves.toBeUndefined()
    ctx.emit('session/disposed', session)
    await expect(ctx.workspaceChanges.restore(session.id, seq, 0, 'before', signal)).resolves.toBeUndefined()
  })
})
