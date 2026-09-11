/** The footer surface's store behavior over a scripted `remote.authorization`. */

import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { AuthorizationAdoptEntry, AuthorizationEntryView, AuthorizationFrameView } from '@fi/api-authorization-controller/types'

import { SignInStore } from '../src/client/store.ts'

const KEY = 'llm-pi-ai/anthropic'

/** One scripted answer per Remote verb the ff store speaks. */
interface Script {
  list: AuthorizationEntryView[]
  adoptEntries: AuthorizationAdoptEntry[]
  frames: AuthorizationFrameView[]
  adoptResult: { route: 'created' | 'already' | 'skipped'; models: string[] }
}

function scriptedCtx(script: Script): { ctx: ClientContext; calls: string[] } {
  const calls: string[] = []
  async function* stream(): AsyncIterable<AuthorizationFrameView> {
    for (const frame of script.frames) yield frame
  }
  const remote = {
    authorization: {
      list: vi.fn(async () => { calls.push('list'); return { ok: true as const, value: script.list } }),
      listAdoptable: vi.fn(async () => { calls.push('listAdoptable'); return { ok: true as const, value: script.adoptEntries } }),
      begin: vi.fn(() => { calls.push('begin'); return stream() }),
      adopt: vi.fn(async (key: string) => { calls.push(`adopt:${key}`); return { ok: true as const, value: script.adoptResult } }),
      cancel: vi.fn(async () => { calls.push('cancel') }),
      answer: vi.fn(async () => { calls.push('answer') }),
      revoke: vi.fn(async () => { calls.push('revoke') }),
    },
  }
  return { ctx: { remote } as unknown as ClientContext, calls }
}

describe('footer store', () => {
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

    expect(calls).toEqual(['begin', 'adopt:llm-pi-ai/anthropic', 'list', 'listAdoptable'])
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
    })
    // Match the RemoteErrorResult the real client would hand back.
    // The bare ClientContext in this file does not pull the controller's
    // ctx.remote merge, so `authorization` is untyped here; the scripted
    // double above shapes it, and this cast preserves the seam the real
    // Remote client would answer.
    ;(ctx.remote as unknown as { authorization: { adopt: unknown } }).authorization.adopt = async () => ({
      ok: false as const,
      error: { code: 'authorization/no-grant', message: 'no stored grant; sign in first' },
    })
    const store = new SignInStore(ctx)
    await store.adopt(KEY)

    const state = store.store.getSnapshot()
    expect(state.adopted).toBeNull()
    expect(state.error).toContain('no stored grant')
    store.dispose()
  })
})
