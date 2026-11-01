/** Service composition: settings policy, configuration validation, route sync, and discovery. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SubscriptionService from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

afterEach(() => { vi.unstubAllGlobals() })
const defaults = {
  requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000, authTimeoutMs: 2000, pollIntervalMs: 1, refreshMarginMs: 60_000,
  defaultContextWindow: 32768, defaultMaxTokens: 1024, kiroRegion: 'us-east-1', geminiProjectId: '', geminiClientId: 'client',
  geminiClientSecret: 'secret', geminiCallbackPort: 45289, providers: {},
}
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'fi-subscriptions-service-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(LlmRuntime)
  return ctx
}

it('keeps its own page off the generated settings while Settings is mounted and releases the policy on disposal', async () => {
  const ctx = await harness()
  const release = vi.fn()
  const configure = vi.fn((_policy: unknown) => release)
  ctx.provide('settings', { configure } as never)
  const live = await liveConfig(ctx, SubscriptionService, defaults, 'fi-subscriptions')
  expect(configure).toHaveBeenCalledOnce()
  expect(configure.mock.calls[0]?.[0]).toEqual({ auto: false })
  await live.fiber.dispose()
  expect(release).toHaveBeenCalledOnce()
})

it('lists configurable providers under the default namespace when mounted without a Loader entry', async () => {
  const ctx = await harness()
  await ctx.plugin(SubscriptionService, defaults as never)
  await ctx.fiber.await()
  expect(ctx.llm.listConfigurableProviders().map(entry => entry.settingsNs)).toEqual(Array(5).fill('fi-subscriptions'))
  expect(ctx.llm.listProviders()).toEqual([])
})

it('registers routes as configuration changes and refuses discovery without a provider', async () => {
  const ctx = await harness()
  const live = await liveConfig(ctx, SubscriptionService, { ...defaults, providers: { cline: { displayName: 'Cline', models: [] } } }, 'subs')
  expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['cline'])
  await live.update({ providers: { kiro: { displayName: 'Kiro', models: [] } } })
  expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toContain('kiro')
  await live.replace({ ...defaults, providers: {} })
  expect(ctx.llm.listProviders()).toEqual([])
  await expect(ctx.llm.discoverModels('subs', { baseURL: 'https://example.test' })).rejects.toThrow('requires a provider')
})

it('rejects an invalid Kiro region, Cloud project, or route at load', async () => {
  const ctx = await harness()
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
  const mount = (config: object) => liveConfig(ctx, SubscriptionService, { ...defaults, ...config }, 'invalid')
  await expect(mount({ kiroRegion: 'not a region' })).rejects.toThrow()
  await expect(mount({ geminiProjectId: 'BAD PROJECT' })).rejects.toThrow()
  await expect(mount({ providers: { bogus: { displayName: 'x', models: [] } } })).rejects.toThrow()
  await expect(mount({ geminiProjectId: 'valid-project-1' })).resolves.toBeDefined()
})
