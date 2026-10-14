/** The footer surface's store behavior over a scripted `remote.authorization`. */

import { describe, expect, it, vi } from 'vitest'
import { Context as ClientContext } from '@deepseek-ai/cordis'
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
      list: vi.fn(async (): Promise<RemoteResult<AuthorizationEntryView[]>> => { calls.push('list'); return { ok: true as const, value: script.list } }),
      listAdoptable: vi.fn(async (): Promise<RemoteResult<AuthorizationAdoptEntry[]>> => { calls.push('listAdoptable'); return { ok: true as const, value: script.adoptEntries } }),
      begin: vi.fn<(_request: { key: string }, _signal: AbortSignal) => AsyncIterable<AuthorizationFrameView>>(() => { calls.push('begin'); return stream() }),
      adopt: vi.fn(async (key: string): Promise<RemoteResult<Script['adoptResult']>> => {
        calls.push(`adopt:${key}`)
        if (script.adoptError !== undefined) {
          return { ok: false as const, error: new RemoteError('authorization/adopt-blocked', script.adoptError, { key }) }
        }
        return { ok: true as const, value: script.adoptResult }
      }),
      cancel: vi.fn(async (): Promise<RemoteResult<void>> => { calls.push('cancel'); return { ok: true, value: undefined } }),
      answer: vi.fn(async (): Promise<RemoteResult<void>> => { calls.push('answer'); return { ok: true as const, value: undefined } }),
      revoke: vi.fn(async (): Promise<RemoteResult<void>> => { calls.push('revoke'); return { ok: true as const, value: undefined } }),
    },
  }
  const ctx = new ClientContext()
  ctx.provide('remote', remote)
  return { ctx, calls, remote }
}

describe('footer store', () => {
  it('uses the offered Ollama device method before adopting the signed-in route', async () => {
    const key = 'fi-ollama/ollama-cloud'
    const { ctx, remote } = scriptedCtx({
      list: [{ key, label: 'Ollama Cloud', methods: [{ id: 'device', label: 'Sign in' }], stored: false, inFlight: false }],
      adoptEntries: [{ key, label: 'Ollama Cloud', routeId: 'ollama-cloud' }],
      frames: [{ kind: 'settled', status: 'authorized', route: 'created' }],
      adoptResult: { route: 'created', models: ['test-model'] },
    })
    const store = new SignInStore(ctx)
    await store.load()
    await store.signInAndAdopt(key)
    expect(remote.authorization.begin).toHaveBeenCalledWith({ key, method: 'device' }, expect.any(AbortSignal))
    expect(store.store.getSnapshot().adopted).toEqual({ key, route: 'created', models: ['test-model'] })
    store.dispose()
  })
  it('keeps the last adoption directory when its refresh is refused', async () => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    remote.authorization.listAdoptable.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
    const store = new SignInStore(ctx)
    await store.load()
    expect(store.store.getSnapshot().error).toBe('offline')
    store.dispose()
  })

  it('ignores adoption directory completion after disposal', async () => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const pending = Promise.withResolvers<{ ok: true; value: AuthorizationAdoptEntry[] }>()
    remote.authorization.listAdoptable.mockReturnValue(pending.promise)
    const store = new SignInStore(ctx)
    const operation = store.load()
    await vi.waitFor(() => { expect(remote.authorization.listAdoptable).toHaveBeenCalled() })
    store.dispose()
    const snapshot = store.store.getSnapshot()
    pending.resolve({ ok: true, value: [] })
    await operation
    expect(store.store.getSnapshot()).toBe(snapshot)
  })

  it.each(['frame', 'failure', 'disposed-failure'] as const)('ignores late stream %s after retirement', async (kind) => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const pending = Promise.withResolvers<undefined>()
    remote.authorization.begin.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {
      await pending.promise
      if (kind !== 'frame') throw new Error('late failure')
      yield { kind: 'notice', message: 'late frame' } as const
    } }))
    const store = new SignInStore(ctx)
    const operation = store.begin(KEY)
    if (kind === 'disposed-failure') store.dispose()
    else store.dismiss()
    const snapshot = store.store.getSnapshot()
    pending.resolve(undefined)
    await operation
    expect(store.store.getSnapshot()).toBe(snapshot)
    store.dispose()
  })

  it.each([false, true])('does not restore an answered prompt after a newer question; rejection=%s', async (reject) => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const pending = Promise.withResolvers<RemoteResult<void>>()
    remote.authorization.answer.mockReturnValue(pending.promise)
    const store = new SignInStore(ctx)
    store.store.set({ ...store.store.getSnapshot(), attempt: { key: KEY, notice: null, settled: null, prompt: { id: 1, kind: 'text', message: 'Old' } } })
    const operation = store.answer('code')
    store.store.set({ ...store.store.getSnapshot(), attempt: { key: KEY, notice: null, settled: null, prompt: { id: 2, kind: 'text', message: 'New' } } })
    if (reject) pending.reject(new Error('old failure'))
    else pending.resolve({ ok: false, error: new RemoteError('gateway/internal', 'old failure', {}) })
    await operation
    expect(store.store.getSnapshot()).toMatchObject({ error: null, attempt: { prompt: { id: 2 } } })
    store.dispose()
  })

  it('ignores a successful answer after dismissal', async () => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const pending = Promise.withResolvers<RemoteResult<void>>()
    remote.authorization.answer.mockReturnValue(pending.promise)
    const store = new SignInStore(ctx)
    store.store.set({ ...store.store.getSnapshot(), attempt: { key: KEY, notice: null, settled: null, prompt: { id: 1, kind: 'text', message: 'Code' } } })
    const operation = store.answer('code')
    store.dismiss()
    const snapshot = store.store.getSnapshot()
    pending.resolve({ ok: true, value: undefined })
    await operation
    expect(store.store.getSnapshot()).toBe(snapshot)
    store.dispose()
  })

  it.each(['begin', 'remove'] as const)('retires %s during its final row reload', async (method) => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [{ kind: 'settled', status: 'cancelled' }], adoptResult: { route: 'already', models: [] } })
    const pending = Promise.withResolvers<RemoteResult<AuthorizationEntryView[]>>()
    remote.authorization.list.mockReturnValue(pending.promise)
    const store = new SignInStore(ctx)
    const operation = store[method](KEY)
    await vi.waitFor(() => { expect(remote.authorization.list).toHaveBeenCalled() })
    store.dispose()
    const snapshot = store.store.getSnapshot()
    pending.resolve({ ok: true, value: [] })
    await operation
    expect(store.store.getSnapshot()).toBe(snapshot)
  })
  it.each([false, true])('retains existing rows after a list refusal; loaded=%s', async (loaded) => {
    const { ctx, remote } = scriptedCtx({ list: [{ key: KEY, label: 'Claude', stored: true, inFlight: false, methods: [{ id: 'oauth', label: 'OAuth' }] }], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const store = new SignInStore(ctx)
    if (loaded) await store.load()
    remote.authorization.list.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: loaded ? 'ready' : 'failed', error: 'offline' })
    store.dispose()
  })

  it.each([false, true])('retains existing rows after a thrown list failure; loaded=%s', async (loaded) => {
    const { ctx, remote } = scriptedCtx({ list: [{ key: KEY, label: 'Claude', stored: true, inFlight: false, methods: [{ id: 'oauth', label: 'OAuth' }] }], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const store = new SignInStore(ctx)
    if (loaded) await store.load()
    remote.authorization.list.mockRejectedValue(loaded ? new Error('offline') : 'offline')
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: loaded ? 'ready' : 'failed', error: 'offline' })
    store.dispose()
  })

  it('preserves an adoption only while its grant remains stored', async () => {
    const script: Script = { list: [{ key: XAI, label: 'Grok', stored: true, inFlight: false, methods: [{ id: 'oauth', label: 'OAuth' }] }, { key: KEY, label: 'Claude', stored: true, inFlight: false, methods: [{ id: 'oauth', label: 'OAuth' }] }], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } }
    const { ctx } = scriptedCtx(script)
    const store = new SignInStore(ctx)
    await store.adopt(KEY)
    await store.load()
    expect(store.store.getSnapshot().adopted?.key).toBe(KEY)
    script.list = script.list.map(row => ({ ...row, stored: false }))
    await store.load()
    expect(store.store.getSnapshot().adopted).toBeNull()
    store.dispose()
  })

  it.each(['list', 'adopt-list'] as const)('ignores a late %s failure after disposal', async (stage) => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const pending = Promise.withResolvers<never>()
    if (stage === 'list') remote.authorization.list.mockReturnValue(pending.promise)
    else remote.authorization.listAdoptable.mockReturnValue(pending.promise)
    const store = new SignInStore(ctx)
    const operation = store.load()
    if (stage === 'adopt-list') await vi.waitFor(() => { expect(remote.authorization.listAdoptable).toHaveBeenCalled() })
    store.dispose()
    const snapshot = store.store.getSnapshot()
    pending.reject(new Error('late failure'))
    await operation
    expect(store.store.getSnapshot()).toBe(snapshot)
  })

  it.each([new Error('offline'), 'offline'])('reports stream, answer, cancellation, adoption and removal transport failures: %s', async (error) => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const store = new SignInStore(ctx)
    remote.authorization.begin.mockImplementation(() => { throw error })
    await store.begin(KEY)
    expect(store.store.getSnapshot().attempt?.settled).toEqual({ status: 'failed', message: 'offline' })
    store.store.set({ ...store.store.getSnapshot(), attempt: { key: KEY, notice: null, settled: null, prompt: { id: 1, kind: 'text', message: 'Code' } } })
    remote.authorization.answer.mockRejectedValue(error)
    await store.answer('code')
    expect(store.store.getSnapshot()).toMatchObject({ error: 'offline', attempt: { prompt: { id: 1 } } })
    remote.authorization.cancel.mockRejectedValue(error)
    await store.cancel()
    expect(store.store.getSnapshot().error).toBe('offline')
    store.dismiss()
    remote.authorization.adopt.mockRejectedValue(error)
    await store.adopt(KEY)
    expect(store.store.getSnapshot().error).toBe('offline')
    remote.authorization.revoke.mockRejectedValue(error)
    await store.remove(KEY)
    expect(store.store.getSnapshot().error).toBe('offline')
    store.dispose()
  })

  it('ignores missing prompts and attempts, and marks an unterminated stream failed', async () => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const store = new SignInStore(ctx)
    await store.answer('unused')
    await store.cancel()
    store.dismiss()
    expect(remote.authorization.answer).not.toHaveBeenCalled()
    expect(remote.authorization.cancel).not.toHaveBeenCalled()
    await store.begin(KEY)
    expect(store.store.getSnapshot().attempt?.settled).toEqual({ status: 'failed', message: 'authorization flow ended without a result' })
    store.dispose()
  })

  it('blocks duplicate operations while adoption is pending', async () => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const pending = Promise.withResolvers<RemoteResult<Script['adoptResult']>>()
    remote.authorization.adopt.mockReturnValue(pending.promise)
    const store = new SignInStore(ctx)
    const operation = store.adopt(KEY)
    await store.begin(KEY)
    await store.adopt(KEY)
    await store.remove(KEY)
    expect(remote.authorization.begin).not.toHaveBeenCalled()
    expect(remote.authorization.revoke).not.toHaveBeenCalled()
    expect(remote.authorization.adopt).toHaveBeenCalledOnce()
    store.dispose()
    const snapshot = store.store.getSnapshot()
    pending.reject(new Error('late failure'))
    await operation
    expect(store.store.getSnapshot()).toBe(snapshot)
  })

  it.each(['answer', 'cancel'] as const)('ignores a late rejected %s after dismissal', async (method) => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const pending = Promise.withResolvers<RemoteResult<void>>()
    remote.authorization[method].mockReturnValue(pending.promise)
    const store = new SignInStore(ctx)
    store.store.set({ ...store.store.getSnapshot(), attempt: { key: KEY, notice: null, settled: null, prompt: { id: 1, kind: 'text', message: 'Code' } } })
    const operation = method === 'answer' ? store.answer('code') : store.cancel()
    store.dismiss()
    const snapshot = store.store.getSnapshot()
    pending.reject(new Error('late failure'))
    await operation
    expect(store.store.getSnapshot()).toBe(snapshot)
    store.dispose()
  })

  it('clears an accepted prompt and sends cancellation without dismissing the attempt', async () => {
    const { ctx } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const store = new SignInStore(ctx)
    store.store.set({ ...store.store.getSnapshot(), attempt: { key: KEY, notice: null, settled: null, prompt: { id: 1, kind: 'text', message: 'Code' } } })
    await store.answer('code')
    await store.cancel()
    expect(store.store.getSnapshot()).toMatchObject({ error: null, attempt: { key: KEY, prompt: null } })
    store.dispose()
  })
  it('does not publish a successful revoke after disposal', async () => {
    const { ctx, remote } = scriptedCtx({ list: [], adoptEntries: [], frames: [], adoptResult: { route: 'already', models: [] } })
    const response = deferred<RemoteResult<void>>()
    remote.authorization.revoke.mockReturnValue(response.promise)
    const store = new SignInStore(ctx)
    await store.adopt(KEY)
    const pending = store.remove(KEY)
    store.dispose()
    const disposed = store.store.getSnapshot()
    response.resolve({ ok: true, value: undefined })
    await pending
    expect(store.store.getSnapshot()).toBe(disposed)
  })
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
    const { ctx, calls, remote } = scriptedCtx({
      list: [{ key: KEY, label: 'Anthropic', methods: [{ id: 'oauth', label: 'Anthropic' }], stored: false, inFlight: false }],
      adoptEntries: [{ key: KEY, label: 'Anthropic', routeId: 'anthropic' }],
      frames: [],
      adoptResult: { route: 'created', models: [] },
    })
    remote.authorization.revoke.mockImplementation(async () => {
      calls.push('revoke')
      throw new Error('authorization/in-flight')
    })
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
    const { ctx, remote } = scriptedCtx({
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
    remote.authorization.adopt.mockImplementation(async () => ({
      ok: false as const,
      error: new RemoteError('authorization/adopt-blocked', 'the settings route could not be written', { key: XAI }),
    }))
    await store.signInAndAdopt(XAI)

    const state = store.store.getSnapshot()
    expect(state.adopted).toBeNull()
    expect(state.error).toContain('could not be written')
    store.dispose()
  })

  it('restores a prompt and exposes a refused answer so the user can retry', async () => {
    const { ctx, remote } = scriptedCtx({
      list: [], adoptEntries: [], frames: [], adoptResult: { route: 'created', models: [] },
    })
    remote.authorization.answer.mockImplementation(async () => ({
      ok: false as const,
      error: new RemoteError('authorization/no-prompt', 'the code expired', { key: KEY, id: 4 }),
    }))
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
    const { ctx, remote } = scriptedCtx({
      list: [], adoptEntries: [], frames: [], adoptResult: { route: 'created', models: [] },
    })
    remote.authorization.list.mockImplementation(async () => ({
      ok: false as const,
      error: new RemoteError('gateway/internal', 'connection reset', {}),
    }))
    const store = new SignInStore(ctx)

    await store.load()

    expect(store.store.getSnapshot()).toMatchObject({ status: 'failed', error: 'connection reset' })
    store.dispose()
  })

  it('exposes a refused cancellation without dismissing the active attempt', async () => {
    const { ctx, remote } = scriptedCtx({
      list: [], adoptEntries: [], frames: [], adoptResult: { route: 'created', models: [] },
    })
    remote.authorization.cancel.mockImplementation(async () => ({
      ok: false as const,
      error: new RemoteError('gateway/internal', 'the provider cannot stop yet', {}),
    }))
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
    const { ctx, remote } = scriptedCtx({
      list: [{ key: KEY, label: 'Anthropic', methods: [{ id: 'oauth', label: 'Anthropic' }], stored: true, inFlight: false }],
      adoptEntries: [{ key: KEY, label: 'Anthropic', routeId: 'anthropic' }],
      frames: [], adoptResult: { route: 'created', models: [] },
    })
    remote.authorization.revoke.mockImplementation(async () => ({
      ok: false as const,
      error: new RemoteError('gateway/internal', 'the provider is still busy', {}),
    }))
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
    const { ctx, remote } = scriptedCtx({
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
    remote.authorization.begin.mockImplementation((
      request: { key: string }, signal: AbortSignal,
    ): AsyncIterable<AuthorizationFrameView> => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<AuthorizationFrameView> {
        if (request.key === KEY) {
          yield { kind: 'settled', status: 'authorized' }
          return
        }
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      },
    }))
    remote.authorization.adopt.mockImplementation(async () => {
      adoptionStarted.resolve(undefined)
      return { ok: true as const, value: await adopted.promise }
    })
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
