/** Ollama Cloud subscription sign-in and model routes for FI. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { OllamaAdapter } from './adapter.ts'
import type { OllamaProfile } from './adapter.ts'
import { registerOllamaFlow, resolveOllamaGrant } from './authorization.ts'
import type { OllamaOptions } from './protocol.ts'

export { OllamaAdapter } from './adapter.ts'
export { OLLAMA_KEY, resolveOllamaGrant } from './authorization.ts'
export type { OllamaGrant, OllamaOptions } from './protocol.ts'

// Native subscription profiles share the Models page's ids-only settings representation.
/* jscpd:ignore-start */
/** Provider routes and non-secret device configuration. */
export interface OllamaConfig extends OllamaOptions {
  /** FI route ids and model-picker selections backed by the signed-in account. */
  providers: Volatile<Record<string, OllamaProfile>>
}

/** Validated deployment settings; cloud identity and signed endpoints are protocol constants. */
export const Config = z.object({
  providers: z.dict(z.object({ displayName: z.string(), models: z.union([z.array(z.string())]) })).default({}).volatile(),
  /* jscpd:ignore-end */
  deviceName: z.string().default('FI'),
  requestTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(30_000),
  authTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(600_000),
  pollIntervalMs: z.number().step(1).min(1).max(2_147_483_647).default(2000),
  streamIdleTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(120_000),
  defaultContextWindow: z.number().step(1).min(1).default(32_768),
  defaultMaxTokens: z.number().step(1).min(1).default(8192),
}) as z<OllamaConfig>

/** Own device authorization and inference registrations for this plugin lifetime. */
export default class OllamaService extends Service {
  static inject = ['authorization', 'credentials', 'llm']
  static Config = Config

  constructor(ctx: Context, config: OllamaConfig) {
    super(ctx, 'fi-ollama')
    if (!config.deviceName.trim()) throw new Error('Ollama device name must not be empty')
    const options = (): OllamaOptions => ({ ...config })
    registerOllamaFlow(this.ctx, options)
    this.ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, this.ctx.fiber)) })
    const settingsNs = this.ctx.fiber.entry?.options.id ?? 'fi-ollama'
    const adapter = new OllamaAdapter(options, signal => resolveOllamaGrant(this.ctx, signal), provider => config.providers.get()[provider])
    // Route replacement belongs to this adapter's independently configured lifetime.
    /* jscpd:ignore-start */
    let registration: AdapterRegistrationHandle | undefined
    const sync = (): void => {
      const routes = Object.keys(config.providers.get())
      if (registration === undefined) {
        if (routes.length > 0) registration = this.ctx.llm.registerAdapter(routes, adapter)
      } else registration.replace(routes)
    }
    sync()
    this.ctx.on('loader/volatile-update', sync)
    /* jscpd:ignore-end */
    const entries = () => [{ provider: 'ollama-cloud', displayName: adapter.providerInfo('ollama-cloud').name,
      settingsNs, settingsPath: ['providers', 'ollama-cloud'] }]
    const directory = this.ctx.llm.registerConfigurableProviders(entries())
    this.ctx.on('loader/volatile-update', () => { directory.replace(entries()) })
    this.ctx.llm.registerModelDiscovery(settingsNs, async request => (await adapter.discoverModels(request.provider ?? 'ollama-cloud')).map(model => ({ id: model.id, name: model.name })))
  }
}
