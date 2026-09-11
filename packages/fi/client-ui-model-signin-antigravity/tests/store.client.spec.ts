/**
 * The Antigravity sign-in store: one row, one attempt, one grant.
 *
 * Unlike the pi-ai card, which joins an OFFERED list against the Host's
 * registered flows, this card knows exactly one provider: Antigravity. It
 * appears when the Host has registered the `fi-antigravity/antigravity`
 * flow and no grant is stored, and disappears once one is.
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'

import { SignInStore } from '../src/client/store.ts'

/** A stub Remote namespace service that Cordis accepts as a provider. */
class RemoteStub extends Service {
  static inject = []
  constructor(ctx: Context, stub: unknown) {
    super(ctx, 'remote.authorization')
    ctx.set('remote.authorization', stub)
  }
}

describe('SignInStore', () => {
  it('starts fresh with no offer', () => {
    const ctx = new Context()
    const store = new SignInStore(ctx)
    const state = store.store.getSnapshot()
    expect(state.status).toBe('idle')
    expect(state.rows).toEqual([])
    expect(state.attempt).toBe(null)
    store.dispose()
  })

  it('reports offered when the Host registers the flow', async () => {
    const ctx = new Context()
    // Simulate the Remote namespace by mounting a stub service.
    const stub = {
      list: async () => [{
        key: 'fi-antigravity/antigravity',
        label: 'Antigravity',
        methods: [{ id: 'oauth', label: 'Sign in with Antigravity' }],
        inFlight: false,
        stored: false,
      }],
      begin: async () => { throw new Error('not implemented') },
      cancel: async () => {},
      revoke: async () => {},
      answer: async () => {},
      adopt: async () => ({ route: 'created', models: [] }),
    }
    // The store reads ctx.get('remote.authorization'), so we provide it via
    // a named service that Cordis recognizes.
    await ctx.plugin(RemoteStub, stub)
    const store = new SignInStore(ctx)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.rows.length).toBe(1)
    expect(state.rows[0]?.stored).toBe(false)
    store.dispose()
  })

  it('reports stored when a grant exists', async () => {
    const ctx = new Context()
    const stub = {
      list: async () => [{
        key: 'fi-antigravity/antigravity',
        label: 'Antigravity',
        methods: [{ id: 'oauth', label: 'Sign in with Antigravity' }],
        inFlight: false,
        stored: true,
      }],
      begin: async () => { throw new Error('not implemented') },
      cancel: async () => {},
      revoke: async () => {},
      answer: async () => {},
      adopt: async () => ({ route: 'created', models: [] }),
    }
    await ctx.plugin(RemoteStub, stub)
    const store = new SignInStore(ctx)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.rows.length).toBe(1)
    expect(state.rows[0]?.stored).toBe(true)
    store.dispose()
  })
})
