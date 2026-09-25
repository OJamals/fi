/** FI subscription-provider metadata and pi-ai transport integration. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SubscriptionProvider } from './headers.ts'
import { subscriptionFetch } from './fetch.ts'
import { subscriptionWebSocket, subscriptionWebSocketConnector } from './websocket.ts'

export * from './fetch.ts'
export * from './headers.ts'
export * from './settings.ts'
export * from './websocket.ts'

export const name = 'fi-provider-compat'

/** Subscription transport limits configured by the FI deployment. */
export interface Config {
  /** Maximum received Codex WebSocket message size in bytes. */
  websocketMaxPayloadBytes?: number
}

/** Reject unlimited, fractional, negative, or unsafe payload limits at plugin load. */
export const Config: z<Config> = z.object({
  websocketMaxPayloadBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(100 * 1024 * 1024),
})

function subscriptionProvider(provider: string): provider is SubscriptionProvider {
  return provider === 'anthropic' || provider === 'openai-codex' || provider === 'xai'
}

/** Resolve schema defaults before constructing a socket owner. */
function resolveConfig(config: Config): Required<Config> {
  return Config(config) as Required<Config>
}

/**
 * Register subscription-only pi-ai request transport metadata.
 * @param ctx - plugin context owning the listener and connector lifetime.
 * @param config - deployment payload limit, resolved through the plugin schema.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const connector = subscriptionWebSocketConnector(resolved.websocketMaxPayloadBytes)
  ctx.effect(() => () => connector.dispose())
  ctx.on('llm-pi-ai/request-transport', async (request, next) => {
    const downstream = await next()
    if (!subscriptionProvider(request.provider)) return downstream
    return {
      ...downstream,
      ...request.provider === 'openai-codex' ? { websocketFactory: subscriptionWebSocket(request, connector) } : {},
      fetch: subscriptionFetch(
        { ...request, provider: request.provider },
        downstream?.fetch ?? globalThis.fetch,
      ),
    }
  })
}
