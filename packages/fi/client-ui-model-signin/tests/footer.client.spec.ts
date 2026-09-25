/** The footer surface's store behavior over a scripted `remote.authorization`. */

import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { AuthorizationAdoptEntry, AuthorizationEntryView, AuthorizationFrameView } from '@fi/api-authorization-controller/types'

import { SignInStore } from '../src/client/store.ts'

const KEY = 'llm-pi-ai/anthropic'
const XAI = 'llm-pi-ai/xai'

/** One scripted answer per Remote verb the ff store speaks. */
interface Script {
  list: AuthorizationEntryView[]
  adoptEntries: AuthorizationAdoptEntry[]
  frames: AuthorizationFrameView[]
  adoptResult: { route: 'created' | 'already' | 'skipped'; models: string[] }
  /** When set, the scripted adopt refuses with this diagnostic. */
  adoptError?: string
}

/** A test-controlled asynchronous result, without wall-clock timing. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => { resolve = done }),
    resolve,
  }
}

function scriptedCtx(script: Script) {
  const calls: string[] = []
  async function* stream(): AsyncIterable<AuthorizationFrameView> {
    for (const frame of script.frames) yield frame
  }
  const remote = {
    authorization: {
      list: vi.fn(async () => { calls.push('list'); return { ok: true as const, value: script.list } }),
      listAdoptable: vi.fn(async () => { calls.push('listAdoptable'); return { ok: true as const, value: script.adoptEntries } }),
      begin: vi.fn(() => { calls.push('begin'); return stream() }),
      adopt: vi.fn(async (key: string) => {
        calls.push(`adopt:${key}`)
        if (script.adoptError !== undefined) {
          return { ok: false as const, error: { code: 'authorization/adopt-blocked', message: script.adoptError } }
        }
        return { ok: true as const, value: script.adoptResult }
      }),
      cancel: vi.fn(async (): Promise<RemoteResult<void>> => { calls.push('cancel'); return { ok: true, value: undefined } }),
      answer: vi.fn(async () => { calls.push('answer'); return { ok: true as const, value: undefined } }),
      revoke: vi.fn(async () => { calls.push('revoke'); return { ok: true as const, value: undefined } }),
    },
  }
  return { ctx: { remote } as unknown as ClientContext, calls, remote }
}

describe('footer store', () => {
  it('ignores a cancel failure after its attempt has been dismissed', async () => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const response = deferred<RemoteResult<void>>()
    remote.authorization.cancel.mockImplementation(() => response.promise)
    const store = new SignInStore(ctx)
    store.store.set({ ...store.store.getSnapshot(), attempt: { key: KEY, notice: null, prompt: null, settled: null } })
    const pending = store.cancel()
    store.dismiss()
    response.resolve({ ok: false, error: new RemoteError('gateway/internal', 'retired attempt error', {}) })
    await pending
    expect(store.store.getSnapshot().error).toBeNull()
    store.dispose()
  })

  it('does not publish a load after disposal', async () => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const response = deferred<{ ok: true; value: AuthorizationEntryView[] }>()
    remote.authorization.list.mockImplementation(() => response.promise)
    const store = new SignInStore(ctx)
    const pending = store.load()
    store.dispose()
    const disposed = store.store.getSnapshot()
    response.resolve({ ok: true, value: [] })
    await pending
    expect(store.store.getSnapshot()).toBe(disposed)
  })

  it('signInAndAdopt runs begin, then adopts once the flow settles authorized', async () => {
    const { ctx, calls } = scriptedCtx({
      list: [{ key: KEY, label: 'Anthropic', methods: [{ id: 'oauth', label: 'Anthropic' }], stored: false, inFlight: false }],
      adoptEntries: [{ key: KEY, label: 'Anthropic', routeId: 'anthropic' }],
      frames: [
        { kind: 'notice', message: 'Complete login', url: 'https://claude.ai/oauth/authorize' },
        { kind: 'settled', status: 'authorized', route: 'created' },
      ],
      adoptResult: { route: 'created', models: ['claude-opus-4-6', 'claude-sonnet-4-6'] },
    })
    const store = new SignInStore(ctx)
    await store.signInAndAdopt(KEY)

    expect(calls).toEqual(['begin', 'list', 'listAdoptable', 'adopt:llm-pi-ai/anthropic'])
    const state = store.store.getSnapshot()
    expect(state.adopted).toEqual({
      key: KEY,
      route: 'created',
      models: ['claude-opus-4-6', 'claude-sonnet-4-6'],
    })
    store.dispose()
  })

  it('signInAndAdopt skips adopt when the attempt fails', async () => {
    const { ctx, calls } = scriptedCtx({
      list: [{ key: KEY, label: 'Anthropic', methods: [{ id: 'oauth', label: 'Anthropic' }], stored: false, inFlight: false }],
      adoptEntries: [{ key: KEY, label: 'Anthropic', routeId: 'anthropic' }],
      frames: [{ kind: 'settled', status: 'failed', message: 'closed the window' }],
      adoptResult: { route: 'created', models: [] },
    })
    const store = new SignInStore(ctx)
    await store.signInAndAdopt(KEY)

    expect(calls).not.toContain('adopt:llm-pi-ai/anthropic')
    expect(store.store.getSnapshot().adopted).toBeNull()
    store.dispose()
  })

  it('adopt alone records the outcome for the footer banner', async () => {
    const { ctx } = scriptedCtx({
      list: [{ key: KEY, label: 'Anthropic', methods: [{ id: 'oauth', label: 'Anthropic' }], stored: true, inFlight: false }],
      adoptEntries: [{ key: KEY, label: 'Anthropic', routeId: 'anthropic' }],
      frames: [],
      adoptResult: { route: 'already', models: ['claude-opus-4-6'] },
    })
    const store = new SignInStore(ctx)
    await store.adopt(KEY)

    expect(store.store.getSnapshot().adopted).toEqual({ key: KEY, route: 'already', models: ['claude-opus-4-6'] })
    store.dispose()
  })

  it('remove reloads the rows even when the revoke itself rejects', async () => {
    const { ctx, calls } = scriptedCtx({
      list: [{ key: KEY, label: 'Anthropic', methods: [{ id: 'oauth', label: 'Anthropic' }], stored: false, inFlight: false }],
      adoptEntries: [{ key: KEY, label: 'Anthropic', routeId: 'anthropic' }],
      frames: [],
      adoptResult: { route: 'created', models: [] },
    })
    ;(ctx.remote as unknown as { authorization: { revoke: unknown } }).authorization.revoke = async () => {
      calls.push('revoke')
      throw new Error('authorization/in-flight')
    }
    const store = new SignInStore(ctx)
    await store.remove(KEY).catch(() => undefined)

    // The reload is the point: a failed revoke must not leave the section
    // rendering the stale stored state the user just tried to clear.
    expect(calls).toEqual(['revoke', 'list', 'listAdoptable'])
    store.dispose()
  })

  it('a refused adopt surfaces as an error, not an adoption', async () => {
    const { ctx } = scriptedCtx({
      list: [{ key: KEY, label: 'Anthropic', methods: [{ id: 'oauth', label: 'Anthropic' }], stored: false, inFlight: false }],
      adoptEntries: [{ key: KEY, label: 'Anthropic', routeId: 'anthropic' }],
      frames: [],
      adoptResult: { route: 'created', models: [] },
      adoptError: 'no stored grant; sign in first',
    })
    const store = new SignInStore(ctx)
    await store.adopt(KEY)

    const state = store.store.getSnapshot()
    expect(state.adopted).toBeNull()
    expect(state.error).toContain('no stored grant')
    store.dispose()
  })

  it('a new attempt clears the previous provider\'s banner, and a failed adopt never restores it', async () => {
    // The reported regression: sign in with one provider, then sign in with
    // another whose adopt fails — the first provider's model list must not
    // stay on screen reading as the second provider's outcome.
    const XAI = 'llm-pi-ai/xai'
    const { ctx } = scriptedCtx({
      list: [
        { key: KEY, label: 'Anthropic', methods: [{ id: 'oauth', label: 'Anthropic' }], stored: false, inFlight: false },
        { key: XAI, label: 'xAI', methods: [{ id: 'oauth', label: 'xAI' }], stored: false, inFlight: false },
      ],
      adoptEntries: [
        { key: KEY, label: 'Anthropic', routeId: 'anthropic' },
        { key: XAI, label: 'xAI', routeId: 'xai' },
      ],
      frames: [{ kind: 'settled', status: 'authorized', route: 'created' }],
      adoptResult: { route: 'created', models: ['claude-opus-4-6'] },
    })
    const store = new SignInStore(ctx)
    await store.signInAndAdopt(KEY)
    expect(store.store.getSnapshot().adopted?.models).toEqual(['claude-opus-4-6'])

    // The second provider's adopt refuses (its route namespace cannot serve
    // it): the banner from the first provider clears at attempt start and
    // the failure lands as the section's error, with nothing stale left.
    ;(ctx.remote as unknown as { authorization: { adopt: unknown } }).authorization.adopt = async () => ({
      ok: false as const,
      error: { code: 'authorization/adopt-blocked', message: 'the settings route could not be written' },
    })
    await store.signInAndAdopt(XAI)

    const state = store.store.getSnapshot()
    expect(state.adopted).toBeNull()
    expect(state.error).toContain('could not be written')
    store.dispose()
  })

  it('restores a prompt and exposes a refused answer so the user can retry', async () => {
    const { ctx } = scriptedCtx({
      list: [], adoptEntries: [], frames: [], adoptResult: { route: 'created', models: [] },
    })
    ;(ctx.remote as unknown as { authorization: { answer: unknown } }).authorization.answer = async () => ({
      ok: false as const,
      error: { code: 'authorization/no-prompt', message: 'the code expired' },
    })
    const store = new SignInStore(ctx)
    store.store.set({
      status: 'ready', rows: [], adoptEntries: [], adopted: null, error: null,
      attempt: { key: KEY, notice: null, prompt: { id: 4, kind: 'text', message: 'Paste the code' }, settled: null },
    })

    await store.answer('123456')

    expect(store.store.getSnapshot()).toMatchObject({
      error: 'the code expired',
      attempt: { prompt: { id: 4, message: 'Paste the code' } },
    })
    store.dispose()
  })

  it('marks an initial list refusal as failed so the footer can offer retry', async () => {
    const { ctx } = scriptedCtx({
      list: [], adoptEntries: [], frames: [], adoptResult: { route: 'created', models: [] },
    })
    ;(ctx.remote as unknown as { authorization: { list: unknown } }).authorization.list = async () => ({
      ok: false as const,
      error: { code: 'authorization/unavailable', message: 'connection reset' },
    })
    const store = new SignInStore(ctx)

    await store.load()

    expect(store.store.getSnapshot()).toMatchObject({ status: 'failed', error: 'connection reset' })
    store.dispose()
  })

  it('exposes a refused cancellation without dismissing the active attempt', async () => {
    const { ctx } = scriptedCtx({
      list: [], adoptEntries: [], frames: [], adoptResult: { route: 'created', models: [] },
    })
    ;(ctx.remote as unknown as { authorization: { cancel: unknown } }).authorization.cancel = async () => ({
      ok: false as const,
      error: { code: 'authorization/cancel-refused', message: 'the provider cannot stop yet' },
    })
    const store = new SignInStore(ctx)
    store.store.set({
      status: 'ready', rows: [], adoptEntries: [], adopted: null, error: null,
      attempt: { key: KEY, notice: null, prompt: null, settled: null },
    })

    await store.cancel()

    expect(store.store.getSnapshot()).toMatchObject({
      error: 'the provider cannot stop yet',
      attempt: { key: KEY, settled: null },
    })
    store.dispose()
  })

  it('keeps a refused revoke diagnostic after refreshing the rows', async () => {
    const { ctx } = scriptedCtx({
      list: [{ key: KEY, label: 'Anthropic', methods: [{ id: 'oauth', label: 'Anthropic' }], stored: true, inFlight: false }],
      adoptEntries: [{ key: KEY, label: 'Anthropic', routeId: 'anthropic' }],
      frames: [], adoptResult: { route: 'created', models: [] },
    })
    ;(ctx.remote as unknown as { authorization: { revoke: unknown } }).authorization.revoke = async () => ({
      ok: false as const,
      error: { code: 'authorization/revoke-refused', message: 'the provider is still busy' },
    })
    const store = new SignInStore(ctx)

    await store.remove(KEY)

    expect(store.store.getSnapshot()).toMatchObject({ status: 'ready', error: 'the provider is still busy' })
    store.dispose()
  })

  it('clears an adopted banner after a successful revoke removes its grant', async () => {
    const { ctx } = scriptedCtx({
      list: [{ key: KEY, label: 'Anthropic', methods: [{ id: 'oauth', label: 'Anthropic' }], stored: false, inFlight: false }],
      adoptEntries: [{ key: KEY, label: 'Anthropic', routeId: 'anthropic' }],
      frames: [], adoptResult: { route: 'created', models: [] },
    })
    const store = new SignInStore(ctx)
    store.store.set({
      status: 'ready', rows: [], attempt: null, error: null,
      adoptEntries: [], adopted: { key: KEY, route: 'created', models: ['claude-opus-4-6'] },
    })

    await store.remove(KEY)

    expect(store.store.getSnapshot().adopted).toBeNull()
    store.dispose()
  })

  it('does not publish an adoption after its settled attempt was dismissed', async () => {
    const adopted = deferred<{ route: 'created'; models: string[] }>()
    const adoptionStarted = deferred<undefined>()
    const { ctx } = scriptedCtx({
      list: [
        { key: KEY, label: 'Anthropic', methods: [{ id: 'oauth', label: 'Anthropic' }], stored: true, inFlight: false },
        { key: XAI, label: 'xAI', methods: [{ id: 'oauth', label: 'xAI' }], stored: false, inFlight: false },
      ],
      adoptEntries: [
        { key: KEY, label: 'Anthropic', routeId: 'anthropic' },
        { key: XAI, label: 'xAI', routeId: 'xai' },
      ],
      frames: [], adoptResult: { route: 'created', models: [] },
    })
    ;(ctx.remote as unknown as { authorization: { begin: unknown; adopt: unknown } }).authorization.begin = (
      request: { key: string }, signal: AbortSignal,
    ): AsyncIterable<AuthorizationFrameView> => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<AuthorizationFrameView> {
        if (request.key === KEY) {
          yield { kind: 'settled', status: 'authorized' }
          return
        }
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      },
    })
    ;(ctx.remote as unknown as { authorization: { adopt: unknown } }).authorization.adopt = async () => {
      adoptionStarted.resolve(undefined)
      return { ok: true as const, value: await adopted.promise }
    }
    const store = new SignInStore(ctx)

    const first = store.signInAndAdopt(KEY)
    await adoptionStarted.promise
    store.dismiss()
    const second = store.begin(XAI)
    expect(store.store.getSnapshot().attempt).toMatchObject({ key: XAI, settled: null })
    adopted.resolve({ route: 'created', models: ['claude-opus-4-6'] })
    await first

    expect(store.store.getSnapshot()).toMatchObject({ attempt: { key: XAI }, adopted: null })
    store.dispose()
    await second
  })
})
