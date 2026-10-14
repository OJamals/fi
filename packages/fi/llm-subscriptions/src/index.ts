/** Native Copilot, Cursor, Kiro, Cline, and Google Code Assist subscriptions. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { SubscriptionAdapter } from './adapter.ts'
import type { SubscriptionProfile } from './adapter.ts'
import { labels, registerFlows, resolveGrant } from './authorization.ts'
import { kiroRegion, providerIds } from './protocol.ts'
import type { SubscriptionOptions } from './protocol.ts'

/** Deployment settings and canonical provider selections. */
export interface SubscriptionConfig extends SubscriptionOptions {
  /** Provider ids and Models picker selections. */
  providers: Volatile<Record<string, SubscriptionProfile>>
}

/** Validated request, OAuth, and model defaults. */
export const Config = z.object({
  // Persist the same picker fields as other native adapters without sharing credential ownership.
  /* jscpd:ignore-start */
  providers: z
    .dict(z.object({ displayName: z.string(), models: z.union([z.array(z.string())]) }))
    .default({})
    .volatile(),
  /* jscpd:ignore-end */
  requestTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(30_000),
  streamIdleTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(120_000),
  authTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(600_000),
  pollIntervalMs: z.number().step(1).min(1).max(60_000).default(2000),
  refreshMarginMs: z.number().step(1).min(0).max(3_600_000).default(60_000),
  defaultContextWindow: z.number().step(1).min(1).default(32_768),
  defaultMaxTokens: z.number().step(1).min(1).default(8192),
  kiroRegion: z.string().default('us-east-1'),
  geminiProjectId: z.string().default(''),
  geminiClientId: z.string().default(''),
  geminiClientSecret: z.string().default(''),
  geminiCallbackPort: z.number().step(1).min(1024).max(65535).default(45289),
}) as z<SubscriptionConfig>

/** Own native subscription authorization and model routes for the plugin lifetime. */
export default class SubscriptionService extends Service {
  static inject = ['authorization', 'credentials', 'llm']
  static Config = Config

  constructor(ctx: Context, config: SubscriptionConfig) {
    super(ctx, 'fi-subscriptions')
    kiroRegion({ region: config.kiroRegion })
    if (config.geminiProjectId && !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(config.geminiProjectId))
      throw new Error('Invalid geminiProjectId')
    const options = (): SubscriptionOptions => ({ ...config })
    registerFlows(this.ctx, options)
    this.ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, this.ctx.fiber))
    })
    const settingsNs = this.ctx.fiber.entry?.options.id ?? 'fi-subscriptions'
    const adapter = new SubscriptionAdapter(
      options,
      (id, signal) => resolveGrant(this.ctx, id, options(), signal),
      provider => config.providers.get()[provider],
    )
    this.ctx.effect(() => () => adapter.dispose())
    let registration: AdapterRegistrationHandle | undefined
    const sync = (): void => {
      const routes = Object.keys(config.providers.get())
      for (const route of routes)
        if (!providerIds.some(id => id === route)) throw new Error(`Unknown subscription route: ${route}`)
      if (registration === undefined) {
        if (routes.length) registration = this.ctx.llm.registerAdapter(routes, adapter)
      } else registration.replace(routes)
    }
    sync()
    this.ctx.on('loader/volatile-update', sync)
    const entries = () =>
      providerIds.map(provider => ({
        provider,
        displayName: config.providers.get()[provider]?.displayName ?? labels[provider],
        settingsNs,
        settingsPath: ['providers', provider],
      }))
    const directory = this.ctx.llm.registerConfigurableProviders(entries())
    this.ctx.on('loader/volatile-update', () => {
      directory.replace(entries())
    })
    this.ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
      if (!request.provider) throw new Error('Subscription discovery requires a provider')
      return (await adapter.discoverModels(request.provider)).map(model => ({ id: model.id, name: model.name }))
    })
  }
}
