/** Restoring a listed file's turn-start or turn-end content back to its live path. */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as WorkspaceChanges from '../src/index.ts'
import { endTurn, git, mutate, scratchDir, settle, startTurn } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
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
