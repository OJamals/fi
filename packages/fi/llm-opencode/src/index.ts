/** OpenCode Console subscription plugin: device login, refreshed grants, and authenticated model routes. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { OpenCodeAdapter } from './adapter.ts'
import { registerConsoleFlow, resolveConsoleGrant } from './oauth.ts'
import { consoleUrl } from './protocol.ts'
import type { ConsoleOptions } from './protocol.ts'

export { OpenCodeAdapter } from './adapter.ts'
export { OPENCODE_KEY, resolveConsoleGrant } from './oauth.ts'
export type { ConsoleGrant, ConsoleOptions } from './protocol.ts'

/** Loader configuration; credentials and discovered models are never user-settings fields. */
export interface OpenCodeConfig extends ConsoleOptions {
  /** FI route ids activated by user settings; the grant chooses the account and organization. */
  providers: Volatile<Record<string, Record<string, never>>>
}

/** Positive finite deployment tunables and the source-pinned Console client identity. */
export const Config = z.object({
  providers: z.dict(z.object({})).default({}).volatile(),
  server: z.string().default('https://opencode.ai/console'),
  clientId: z.string().default('opencode-cli'),
  userAgent: z.string().default('opencode/latest/2.0.20/cli'),
  requestTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(30_000),
  streamIdleTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(120_000),
  refreshMarginMs: z.number().step(1).min(0).default(120_000),
  defaultContextWindow: z.number().step(1).min(1).default(128_000),
  defaultMaxTokens: z.number().step(1).min(1).default(8192),
}) as z<OpenCodeConfig>

/** Own OpenCode routes and contributions for the lifetime of this Cordis plugin. */
export default class OpenCodeService extends Service {
  static inject = ['authorization', 'credentials', 'llm']
  static Config = Config

  constructor(ctx: Context, config: OpenCodeConfig) {
    super(ctx, 'fi-opencode')
    const server = consoleUrl(config.server)
    if (!config.clientId || !config.userAgent || /[\r\n]/.test(config.userAgent)) throw new Error('OpenCode client identity must be non-empty and valid HTTP text')
    const options = (): ConsoleOptions => ({ ...config, server })
    registerConsoleFlow(this.ctx, options)
    this.ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, this.ctx.fiber)) })
    const settingsNs = this.ctx.fiber.entry?.options.id ?? 'fi-opencode'
    const adapter = new OpenCodeAdapter(options, (settings, signal) => resolveConsoleGrant(this.ctx, settings, signal))
    let registration: AdapterRegistrationHandle | undefined
    const sync = (): void => {
      const routes = Object.keys(config.providers.get())
      if (registration === undefined) {
        if (routes.length > 0) registration = this.ctx.llm.registerAdapter(routes, adapter)
      } else registration.replace(routes)
    }
    sync()
    this.ctx.on('loader/volatile-update', sync)
    this.ctx.llm.registerConfigurableProviders([{
      provider: 'opencode-console', displayName: 'OpenCode Console', settingsNs, settingsPath: ['providers', 'opencode-console'],
    }])
    this.ctx.llm.registerModelDiscovery(settingsNs, async request => (await adapter.listModels(request.provider ?? 'opencode-console'))
      .map(model => ({ id: model.id, name: model.name })))
  }
}
