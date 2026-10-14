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
import { providerSettingsFor } from '@fi/provider-compat'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { withCompatibilityTools } from './compatibility.ts'

const metadata = providerSettingsFor('opencodeConsole')

export { OpenCodeAdapter } from './adapter.ts'
export { OPENCODE_KEY, resolveConsoleGrant } from './oauth.ts'
export type { ConsoleGrant, ConsoleOptions } from './protocol.ts'

/** Presentation and model selection for a configured Console route. */
interface OpenCodeProfile {
  /** Display label for this configured route. */
  displayName?: string
  /** Model ids enabled for this route; omission uses the discovered catalog. */
  models?: string[]
}

/** Loader configuration; credentials remain exclusively in the credential store. */
export interface OpenCodeConfig extends ConsoleOptions {
  /** FI route ids activated by user settings; the grant chooses the account and organization. */
  providers: Volatile<Record<string, OpenCodeProfile>>
}

/** Positive finite deployment tunables and the source-pinned Console client identity. */
export const Config = z.object({
  providers: z.dict(z.object({ displayName: z.string(), models: z.union([z.array(z.string())]) })).default({}).volatile(),
  server: z.string().default(metadata.server),
  clientId: z.string().default(metadata.oauthClientId),
  userAgent: z.string().default(`opencode/${metadata.channel}/${metadata.version}/${metadata.client}`),
  requestTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(30_000),
  catalogRetryCount: z.number().step(1).min(0).default(1),
  catalogRetryDelayMs: z.number().step(1).min(1).max(2_147_483_647).default(250),
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
    const adapter = new OpenCodeAdapter(options, (settings, signal) => resolveConsoleGrant(this.ctx, settings, signal),
      provider => config.providers.get()[provider])
    this.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      const provider = assembly.variables.provider
      if (provider === undefined || !Object.hasOwn(config.providers.get(), provider)) return assembly
      return { ...assembly, tools: withCompatibilityTools(assembly.tools) }
    })
    let registration: AdapterRegistrationHandle | undefined
    const sync = (): void => {
      const routes = Object.keys(config.providers.get())
      if (registration === undefined) {
        if (routes.length > 0) registration = this.ctx.llm.registerAdapter(routes, adapter)
      } else registration.replace(routes)
    }
    sync()
    this.ctx.on('loader/volatile-update', sync)
    const directoryEntries = () => [{
      provider: 'opencode-console', displayName: adapter.providerInfo('opencode-console').name,
      settingsNs, settingsPath: ['providers', 'opencode-console'],
    }]
    const directory = this.ctx.llm.registerConfigurableProviders(directoryEntries())
    this.ctx.on('loader/volatile-update', () => { directory.replace(directoryEntries()) })
    this.ctx.llm.registerModelDiscovery(settingsNs, async request => (await adapter.discoverModels(request.provider ?? 'opencode-console'))
      .map(model => ({ id: model.id, name: model.name })))
  }
}
