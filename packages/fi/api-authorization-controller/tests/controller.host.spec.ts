import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'

import { FiAuthorizationController } from '../src/index.ts'
import type { AuthorizationFrameView } from '../src/types.ts'

const KEY = 'llm-pi-ai/anthropic'
const dirs: string[] = []

/** In-memory settings provider: the smallest real SettingsProvider subclass. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  constructor(ctx: Context, options?: { doc?: Record<string, unknown> }) {
    super(ctx)
    if (options?.doc !== undefined) this.doc = structuredClone(options.doc)
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** The pi-ai route schema, reduced to what the route write must validate. */
const RouteSchema = z.object({ providers: z.dict(z.object({ displayName: z.string().role('option') })).default({}) })

/** A context with the record store, the seam, this controller, and (optionally) a settings provider. */
async function harness(options?: { settings?: boolean; doc?: Record<string, unknown> }): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'fi-auth-ctl-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  if (options?.settings === true) {
    await ctx.plugin(MemorySettings, { doc: options.doc ?? {} })
    ctx.settings.register('llm-pi-ai', RouteSchema)
  }
  await ctx.plugin(AuthorizationService)
  ctx.plugin(FiAuthorizationController)
  return ctx
}

/** The resolved providers dict of the registered llm-pi-ai namespace. */
function routedProviders(ctx: Context): Record<string, unknown> {
  const view = ctx.settings.describe().find(candidate => candidate.ns === 'llm-pi-ai')
  return (view?.value as { providers?: Record<string, unknown> }).providers ?? {}
}

/**
 * Register one flow whose runner is driven by the test.
 * @param ctx - the harness context.
 * @param run - what the flow does with its session.
 */
function registerFlow(ctx: Context, run: (session: AuthorizationSession) => Promise<void>): void {
  ctx.authorization.registerFlow({
    key: credentialKey('llm-pi-ai', 'anthropic'),
    label: 'Anthropic',
    methods: [{ id: 'oauth', label: 'Anthropic (Claude Pro/Max)' }],
    run,
  })
}

/** Commit a record the way a real flow does, through the credential seam. */
async function commit(ctx: Context): Promise<void> {
  await ctx.credentials.modifyRecord(
    credentialKey('llm-pi-ai', 'anthropic'),
    () => Promise.resolve({ kind: 'grant', payload: { type: 'oauth', access: 'token' } }),
  )
}

/** Drain a begin stream to its end. */
async function drain(stream: AsyncIterable<AuthorizationFrameView>): Promise<AuthorizationFrameView[]> {
  const frames: AuthorizationFrameView[] = []
  for await (const frame of stream) frames.push(frame)
  return frames
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('list', () => {
  it('reports a registered flow and whether its record is stored', async () => {
    const ctx = await harness()
    registerFlow(ctx, async () => { await commit(ctx) })

    const before = await ctx.fiAuthorizationController.list()
    expect(before).toEqual([{
      key: KEY,
      label: 'Anthropic',
      methods: [{ id: 'oauth', label: 'Anthropic (Claude Pro/Max)' }],
      inFlight: false,
      stored: false,
    }])

    await commit(ctx)
    const after = await ctx.fiAuthorizationController.list()
    expect(after[0]?.stored).toBe(true)
  })

  it('refuses when the seam is absent rather than reporting no flows', async () => {
    const ctx = new Context()
    await ctx.plugin(FiAuthorizationController)
    await expect(ctx.fiAuthorizationController.list()).rejects.toThrow(/does not mount the authorization seam/)
  })
})

describe('begin', () => {
  it('streams notices and ends with one settled frame', async () => {
    const ctx = await harness()
    registerFlow(ctx, async (session) => {
      session.notify({ message: 'Open this page', url: 'https://example.test/auth' })
      session.notify({ message: 'Enter this code', url: 'https://example.test/dev', code: 'ABCD-1234' })
      await commit(ctx)
    })

    const frames = await drain(ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal))

    expect(frames).toEqual([
      { kind: 'notice', message: 'Open this page', url: 'https://example.test/auth' },
      { kind: 'notice', message: 'Enter this code', url: 'https://example.test/dev', code: 'ABCD-1234' },
      { kind: 'settled', status: 'authorized', route: 'skipped' },
    ])
  })

  it('carries a question out and the surface answer back in', async () => {
    const ctx = await harness()
    registerFlow(ctx, async (session) => {
      const typed = await session.prompt({ kind: 'text', message: 'Paste the code' })
      expect(typed).toBe('xyz')
      await commit(ctx)
    })

    const stream = ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal)
    const frames: AuthorizationFrameView[] = []
    for await (const frame of stream) {
      frames.push(frame)
      if (frame.kind === 'prompt') ctx.fiAuthorizationController.answer(KEY, frame.id, 'xyz')
    }

    expect(frames[0]).toEqual({ kind: 'prompt', id: 0, prompt: { kind: 'text', message: 'Paste the code' } })
    expect(frames.at(-1)).toEqual({ kind: 'settled', status: 'authorized', route: 'skipped' })
  })

  it('reads an empty answer as the human declining, so the attempt cancels', async () => {
    const ctx = await harness()
    registerFlow(ctx, async (session) => {
      await session.prompt({ kind: 'secret', message: 'API key' })
      await commit(ctx)
    })

    const stream = ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal)
    const frames: AuthorizationFrameView[] = []
    for await (const frame of stream) {
      frames.push(frame)
      if (frame.kind === 'prompt') ctx.fiAuthorizationController.answer(KEY, frame.id, '')
    }

    expect(frames.at(-1)).toEqual({ kind: 'settled', status: 'cancelled' })
  })

  it('reports a flow failure as a settled frame rather than breaking the stream', async () => {
    const ctx = await harness()
    registerFlow(ctx, () => Promise.reject(new Error('the provider said no')))

    const frames = await drain(ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal))

    expect(frames).toEqual([{ kind: 'settled', status: 'failed', message: 'the provider said no' }])
  })

  it('reports a flow that resolves without committing as failed', async () => {
    const ctx = await harness()
    registerFlow(ctx, () => Promise.resolve())

    const frames = await drain(ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal))

    expect(frames.at(-1)).toMatchObject({ kind: 'settled', status: 'failed' })
  })

  it('withdraws a question the flow retires, leaving the attempt running', async () => {
    const ctx = await harness()
    registerFlow(ctx, async (session) => {
      const retire = new AbortController()
      const asked = session.prompt({ kind: 'text', message: 'racing', signal: retire.signal })
      retire.abort()
      await asked.catch(() => undefined)
      await commit(ctx)
    })

    const frames = await drain(ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal))

    expect(frames).toEqual([
      { kind: 'prompt', id: 0, prompt: { kind: 'text', message: 'racing' } },
      { kind: 'withdraw', id: 0 },
      { kind: 'settled', status: 'authorized', route: 'skipped' },
    ])
  })

  it('projects a select prompt with its options', async () => {
    const ctx = await harness()
    registerFlow(ctx, async (session) => {
      const picked = await session.prompt({
        kind: 'select',
        message: 'Which account?',
        options: [{ id: 'a', label: 'Personal', description: 'the default' }, { id: 'b', label: 'Work' }],
      })
      expect(picked).toBe('b')
      await commit(ctx)
    })

    const stream = ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal)
    const frames: AuthorizationFrameView[] = []
    for await (const frame of stream) {
      frames.push(frame)
      if (frame.kind === 'prompt') ctx.fiAuthorizationController.answer(KEY, frame.id, 'b')
    }

    expect(frames[0]).toEqual({
      kind: 'prompt',
      id: 0,
      prompt: {
        kind: 'select',
        message: 'Which account?',
        options: [{ id: 'a', label: 'Personal', description: 'the default' }, { id: 'b', label: 'Work' }],
      },
    })
  })

  it('refuses a key outside the credential grammar', async () => {
    const ctx = await harness()
    expect(() => ctx.fiAuthorizationController.begin({ key: 'Not A Key' }, new AbortController().signal))
      .toThrow(RemoteError)
  })
})

describe('answer', () => {
  it('refuses an answer no question is waiting for', async () => {
    const ctx = await harness()
    expect(() => ctx.fiAuthorizationController.answer(KEY, 7, 'x')).toThrow(/no authorization prompt 7/)
  })
})

describe('cancel', () => {
  it('withdraws the running attempt, which settles as cancelled', async () => {
    const ctx = await harness()
    registerFlow(ctx, async (session) => {
      await new Promise<void>((resolve) => { session.signal.addEventListener('abort', () => { resolve() }) })
      throw new Error('withdrawn')
    })

    const stream = ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal)
    const frames: AuthorizationFrameView[] = []
    const drained = (async () => { for await (const frame of stream) frames.push(frame) })()
    // The flow is parked on its signal; cancelling is what lets it finish.
    await Promise.resolve()
    ctx.fiAuthorizationController.cancel(KEY)
    await drained

    expect(frames.at(-1)).toMatchObject({ kind: 'settled', status: 'cancelled' })
  })
})

describe('the route a sign-in leaves behind', () => {
  it('creates the provider route from nothing when a settings provider is mounted', async () => {
    const ctx = await harness({ settings: true })
    registerFlow(ctx, async () => { await commit(ctx) })

    const frames = await drain(ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal))

    expect(frames.at(-1)).toEqual({ kind: 'settled', status: 'authorized', route: 'created' })
    expect(routedProviders(ctx)).toEqual({ anthropic: {} })
  })

  it('leaves an existing route untouched rather than overwriting its configuration', async () => {
    const ctx = await harness({ settings: true, doc: { 'llm-pi-ai': { providers: { anthropic: { displayName: 'Mine' } } } } })
    registerFlow(ctx, async () => { await commit(ctx) })

    const frames = await drain(ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal))

    expect(frames.at(-1)).toEqual({ kind: 'settled', status: 'authorized', route: 'already' })
    expect(routedProviders(ctx)).toEqual({ anthropic: { displayName: 'Mine' } })
  })

  it('reports the route write as skipped, not failed, when no settings provider is mounted', async () => {
    const ctx = await harness()
    registerFlow(ctx, async () => { await commit(ctx) })

    const frames = await drain(ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal))

    expect(frames.at(-1)).toEqual({ kind: 'settled', status: 'authorized', route: 'skipped' })
    expect(await ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'anthropic'))).toBeDefined()
  })

  it('does not touch settings for a cancelled or failed attempt', async () => {
    const ctx = await harness({ settings: true })
    registerFlow(ctx, () => Promise.reject(new Error('the provider said no')))

    const frames = await drain(ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal))

    expect(frames.at(-1)).toMatchObject({ status: 'failed' })
    expect((frames.at(-1) as { route?: string }).route).toBeUndefined()
    expect(routedProviders(ctx)).toEqual({})
  })
})

describe('revoke', () => {
  it('deletes the stored record, resetting the provider to sign-in-offered', async () => {
    const ctx = await harness({ settings: true })
    registerFlow(ctx, async () => { await commit(ctx) })
    await drain(ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal))
    expect((await ctx.fiAuthorizationController.list())[0]?.stored).toBe(true)

    await ctx.fiAuthorizationController.revoke(KEY)

    const entries = await ctx.fiAuthorizationController.list()
    expect(entries[0]?.stored).toBe(false)
    // The route survives: resetting sign-in is not revoking the user's
    // provider configuration, and the Models page owns deleting routes.
    expect(routedProviders(ctx)).toEqual({ anthropic: {} })
  })

  it('refuses to revoke a key whose attempt is running', async () => {
    const ctx = await harness()
    registerFlow(ctx, async (session) => {
      await new Promise<void>((resolve) => { session.signal.addEventListener('abort', () => { resolve() }) })
      throw new Error('withdrawn')
    })
    const drained = drain(ctx.fiAuthorizationController.begin({ key: KEY }, new AbortController().signal))
    await Promise.resolve()

    await expect(ctx.fiAuthorizationController.revoke(KEY)).rejects.toThrow(/already running/)

    ctx.fiAuthorizationController.cancel(KEY)
    await drained
  })
})
