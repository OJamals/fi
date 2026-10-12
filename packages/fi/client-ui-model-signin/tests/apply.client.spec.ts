/** Sign-in registrations follow service lifetimes and forward typed Remote refusals. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { RemoteResult, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { AuthorizationEntryView } from '@fi/api-authorization-controller/types'
import { apply } from '../src/client/index.ts'
import type { AntigravityProviderEditorInjected } from '../src/client/AntigravityProviderEditor.tsx'

it('disposes a failed injection before returning its error', async () => {
  const failure = new Error('registration failed')
  const dispose = vi.fn(async () => undefined)
  const scoped = Object.assign(Promise.reject(failure), { dispose })
  const inject = vi.fn().mockReturnValueOnce(undefined).mockReturnValueOnce(scoped)
  await expect(apply({ inject } as never)).rejects.toBe(failure)
  expect(dispose).toHaveBeenCalledOnce()
})

it('mounts editors, refreshes offered routes, forwards operations, and releases subscriptions', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry)
  const slots = ctx.slots
  slots.register({ name: 'root', children: {
    'settings.models.footer': { kind: 'list', scope: 'root' },
    'settings.models.provider-editor': { kind: 'keyed', scope: 'root' },
  } } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const disposeRoutes = vi.fn()
  const registerRoutes = vi.fn(() => disposeRoutes)
  ctx.provide('modelSettingsSubscriptions', { register: registerRoutes } as never)
  const disposeGroups = vi.fn()
  const registerGroups = vi.fn(() => disposeGroups)
  ctx.provide('modelSubscriptions', { register: registerGroups } as never)
  const row: AuthorizationEntryView = {
    key: 'fi-antigravity/antigravity', label: 'Antigravity', stored: true, inFlight: false,
    methods: [{ id: 'oauth', label: 'OAuth' }],
  }
  const list = vi.fn(async (): Promise<RemoteResult<AuthorizationEntryView[]>> => ({ ok: true, value: [row] }))
  const view: SettingsNamespaceView = { ns: 'fi-antigravity', value: {}, schema: {}, revision: 1, applies: 'live', autoGenerate: false, secrets: [] }
  const describe = vi.fn(async (): Promise<RemoteResult<{ namespaces: SettingsNamespaceView[] }>> => (
    { ok: true, value: { namespaces: [view] } }
  ))
  const discoverModels = vi.fn(async (): Promise<RemoteResult<[]>> => ({ ok: true, value: [] }))
  const mutate = vi.fn(async (): Promise<RemoteResult<void>> => ({ ok: true, value: undefined }))
  new TestRemote(ctx, {
    authorization: { list, listAdoptable: async () => ({ ok: true, value: [] }) },
    settings: { describe, mutate }, llm: { discoverModels },
  })
  const dispose = await apply(ctx)
  const footer = slots.entries('settings.models.footer')[0]!
  const injected = footer.inject!() as Record<string, unknown> & AntigravityProviderEditorInjected
  await vi.waitFor(() => { expect(registerRoutes).toHaveBeenCalledWith(['antigravity']) })
  expect(slots.entries('settings.models.provider-editor')).toHaveLength(2)
  expect(registerGroups).toHaveBeenCalledOnce()
  await expect(injected.operations.read('fi-antigravity')).resolves.toBe(view)
  await expect(injected.operations.read('missing')).rejects.toThrow('Settings namespace unavailable: missing')
  await expect(injected.operations.discover('fi-antigravity', 'antigravity')).resolves.toEqual([])
  await expect(injected.operations.write('fi-antigravity', [], 1)).resolves.toBeUndefined()
  const refusal = { ok: false as const, error: new RemoteError('gateway/internal', 'offline', {}) }
  describe.mockResolvedValue(refusal)
  discoverModels.mockResolvedValue(refusal)
  mutate.mockResolvedValue(refusal)
  await expect(injected.operations.read('fi-antigravity')).rejects.toThrow('offline')
  await expect(injected.operations.discover('fi-antigravity', 'antigravity')).rejects.toThrow('offline')
  await expect(injected.operations.write('fi-antigravity', [], 1)).rejects.toThrow('offline')
  ctx.emit('connection/reset')
  await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
  await injected.controller.load()
  expect(registerRoutes).toHaveBeenCalledTimes(1)
  list.mockResolvedValue({ ok: true, value: [{ ...row, key: 'llm-pi-ai/xai' }] })
  await injected.controller.load()
  expect(registerRoutes).toHaveBeenLastCalledWith(['xai'])
  await dispose()
  expect(slots.entries('settings.models.footer')).toEqual([])
  expect(disposeRoutes).toHaveBeenCalledTimes(2)
  await ctx.fiber.dispose()
  expect(disposeGroups).toHaveBeenCalledOnce()
})
