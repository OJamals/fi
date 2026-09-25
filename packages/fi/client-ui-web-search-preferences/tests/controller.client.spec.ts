import { describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import {
  PreferredSearchCardController,
  type PreferredSearchSettings,
} from '../src/client/preferred-search-card-controller.ts'
import { apply } from '../src/client/index.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

describe('PreferredSearchCardController', () => {
  it('registers a distinct Plugins-page entry while the Host serves its namespace', () => {
    const host = stubConfigForm<PreferredSearchSettings>()
    const register = vi.fn(() => vi.fn())
    const ctx = {
      locale: { register: vi.fn(() => vi.fn()), bind: vi.fn(() => vi.fn()) },
      configForms: {
        get: vi.fn(() => host.scope),
        whileServed: vi.fn((namespaces: string[], onServed: (served: Set<string>) => () => void) => onServed(new Set(namespaces))),
      },
      remote: {
        $on: vi.fn(() => vi.fn()),
        credentials: {
          describe: vi.fn(async () => ({ ok: true as const, value: {} })),
          set: vi.fn(),
          unset: vi.fn(),
        },
      },
      effect: vi.fn((mount: () => unknown) => mount()),
      slots: {
        inject: vi.fn((_name: string, mount: () => unknown) => mount()),
        register,
      },
    }

    apply(ctx as never)

    expect(ctx.configForms.get).toHaveBeenCalledWith('fi-web-search-preferences')
    expect(ctx.configForms.whileServed).toHaveBeenCalledWith(
      ['fi-web-search-preferences'],
      expect.any(Function),
    )
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'plugins.item',
      id: 'fi-web-search-preferences',
      order: 50,
    }), expect.anything())
    expect(ctx.effect).toHaveBeenCalledWith(
      expect.any(Function),
      'fi-web-search-preferences: card controller',
    )
  })

  it('keeps a provider draft when the Host does not accept the settings mutation', async () => {
    const host = stubConfigForm<PreferredSearchSettings>()
    const describe = vi.fn(async (refs: string[]) => ({
      ok: true as const,
      value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
    }))
    const controller = new PreferredSearchCardController(host.scope, {
      remote: { credentials: { describe, set: vi.fn(), unset: vi.fn() } },
    } as never)
    host.publish({
      status: 'ready',
      writable: true,
      value: { provider: 'exa' },
      base: {},
      user: {},
      revision: 2,
    })
    const face = controller.inject()
    await vi.waitFor(() => {
      expect(face.hooks.preferredSearchCard.getSnapshot().apiKeyChecking).toBe(false)
    })
    face.editProvider('brave')
    await vi.waitFor(() => {
      expect(face.hooks.preferredSearchCard.getSnapshot().apiKeyChecking).toBe(false)
    })
    face.save()

    await vi.waitFor(() => {
      expect(face.hooks.preferredSearchCard.getSnapshot()).toMatchObject({
        provider: 'brave',
        dirty: true,
        failed: true,
      })
    })
  })

  it('addresses the selected provider custom credential reference', async () => {
    const host = stubConfigForm<PreferredSearchSettings>()
    const describe = vi.fn(async (refs: string[]) => ({
      ok: true as const,
      value: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
    }))
    const set = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const unset = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const controller = new PreferredSearchCardController(
      host.scope,
      { remote: { credentials: { describe, set, unset } } } as never,
    )
    host.publish({
      status: 'ready',
      writable: true,
      value: { provider: 'exa', exaApiKeyEnv: 'CUSTOM_EXA_KEY' },
      base: {},
      user: {},
      revision: 1,
    })
    const face = controller.inject()
    await vi.waitFor(() => { expect(describe).toHaveBeenCalledWith(['CUSTOM_EXA_KEY']) })
    await vi.waitFor(() => {
      expect(face.hooks.preferredSearchCard.getSnapshot().apiKeyChecking).toBe(false)
    })
    face.editApiKey(' secret ')
    describe.mockImplementation(async (refs: string[]) => ({
      ok: true as const,
      value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
    }))
    face.save()

    await vi.waitFor(() => { expect(set).toHaveBeenCalledWith('CUSTOM_EXA_KEY', 'secret') })
    expect(face.hooks.preferredSearchCard.getSnapshot().credentialRef).toBe('CUSTOM_EXA_KEY')
  })

  it('writes a credential when the settings document is read-only', async () => {
    const host = stubConfigForm<PreferredSearchSettings>()
    host.publish({
      status: 'ready',
      writable: false,
      value: { provider: 'exa' },
      base: {},
      user: {},
    })
    const describe = vi.fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: { EXA_API_KEY: { configured: false, writable: true } },
      })
      .mockResolvedValue({
        ok: true as const,
        value: { EXA_API_KEY: { configured: true, writable: true } },
      })
    const set = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const controller = new PreferredSearchCardController(host.scope, {
      remote: { credentials: { describe, set, unset: vi.fn() } },
    } as never)
    const face = controller.inject()
    await vi.waitFor(() => {
      expect(face.hooks.preferredSearchCard.getSnapshot().apiKeyChecking).toBe(false)
    })

    face.editApiKey('replacement')
    face.save()

    await vi.waitFor(() => { expect(set).toHaveBeenCalledWith('EXA_API_KEY', 'replacement') })
    await vi.waitFor(() => {
      expect(face.hooks.preferredSearchCard.getSnapshot()).toMatchObject({ dirty: false, failed: false })
    })
  })

  it('drops a stale credential response after provider selection changes', async () => {
    const host = stubConfigForm<PreferredSearchSettings>()
    const exa = deferred<{ ok: true; value: Record<string, { configured: boolean; writable: boolean }> }>()
    const describe = vi.fn((refs: string[]) => refs[0] === 'EXA_API_KEY'
      ? exa.promise
      : Promise.resolve({
        ok: true as const,
        value: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
      }))
    const controller = new PreferredSearchCardController(host.scope, {
      remote: { credentials: { describe, set: vi.fn(), unset: vi.fn() } },
    } as never)
    host.publish({ status: 'ready', writable: true, value: { provider: 'exa' }, base: {}, user: {} })
    const face = controller.inject()
    face.editProvider('brave')
    exa.resolve({ ok: true, value: { EXA_API_KEY: { configured: true, writable: true } } })

    await vi.waitFor(() => {
      expect(face.hooks.preferredSearchCard.getSnapshot()).toMatchObject({
        provider: 'brave',
        credentialRef: 'BRAVE_SEARCH_API_KEY',
        apiKeyConfigured: false,
      })
    })
  })

  it('drops an older response for the same credential reference', async () => {
    const host = stubConfigForm<PreferredSearchSettings>()
    host.publish({ status: 'ready', writable: true, value: { provider: 'exa' }, base: {}, user: {} })
    const older = deferred<{ ok: true; value: Record<string, { configured: boolean; writable: boolean }> }>()
    const newer = deferred<{ ok: true; value: Record<string, { configured: boolean; writable: boolean }> }>()
    const describe = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    const controller = new PreferredSearchCardController(host.scope, {
      remote: { credentials: { describe, set: vi.fn(), unset: vi.fn() } },
    } as never)
    const face = controller.inject()
    await vi.waitFor(() => { expect(describe).toHaveBeenCalledOnce() })
    controller.refreshCredential('EXA_API_KEY')
    await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(2) })

    newer.resolve({ ok: true, value: { EXA_API_KEY: { configured: false, writable: true } } })
    await vi.waitFor(() => {
      expect(face.hooks.preferredSearchCard.getSnapshot().apiKeyChecking).toBe(false)
    })
    older.resolve({ ok: true, value: { EXA_API_KEY: { configured: true, writable: true } } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(face.hooks.preferredSearchCard.getSnapshot().apiKeyConfigured).toBe(false)
  })

  it.each([
    ['a failure response', async () => ({ ok: false as const, error: new Error('describe failed') })],
    ['a rejected request', async () => { throw new Error('transport failed') }],
  ])('settles %s so the user can replace the credential', async (_name, describeCredential) => {
    const host = stubConfigForm<PreferredSearchSettings>()
    host.publish({ status: 'ready', writable: true, value: { provider: 'exa' }, base: {}, user: {} })
    const controller = new PreferredSearchCardController(host.scope, {
      remote: {
        credentials: {
          describe: vi.fn(describeCredential),
          set: vi.fn(),
          unset: vi.fn(),
        },
      },
    } as never)
    const face = controller.inject()

    await vi.waitFor(() => {
      expect(face.hooks.preferredSearchCard.getSnapshot()).toMatchObject({
        apiKeyChecking: false,
        apiKeyWritable: true,
        failed: true,
      })
    })
    face.editApiKey('replacement')
    expect(face.hooks.preferredSearchCard.getSnapshot()).toMatchObject({
      invalid: false,
      failed: false,
    })
  })

  it('stops settings subscriptions and pending reads on disposal', async () => {
    const host = stubConfigForm<PreferredSearchSettings>()
    host.publish({ status: 'ready', writable: true, value: { provider: 'exa' }, base: {}, user: {} })
    const pending = deferred<{ ok: true; value: Record<string, { configured: boolean; writable: boolean }> }>()
    const describe = vi.fn(() => pending.promise)
    const controller = new PreferredSearchCardController(host.scope, {
      remote: { credentials: { describe, set: vi.fn(), unset: vi.fn() } },
    } as never)
    const face = controller.inject()
    await vi.waitFor(() => { expect(describe).toHaveBeenCalledOnce() })

    controller.dispose()
    host.publish({ status: 'ready', writable: true, value: { provider: 'brave' }, base: {}, user: {} })
    pending.resolve({ ok: true, value: { EXA_API_KEY: { configured: true, writable: true } } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(describe).toHaveBeenCalledOnce()
    expect(face.hooks.preferredSearchCard.getSnapshot().provider).toBe('exa')
    expect(face.hooks.preferredSearchCard.getSnapshot().apiKeyConfigured).toBe(false)
  })
})
