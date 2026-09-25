/** FI subscription-provider metadata and pi-ai transport integration. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SubscriptionProvider } from './headers.ts'
import { subscriptionFetch } from './fetch.ts'
import { createLiveModelCaches, fetchLiveModels } from './live-models.ts'
import { subscriptionWebSocket, subscriptionWebSocketConnector } from './websocket.ts'

export * from './fetch.ts'
export * from './headers.ts'
export * from './live-models.ts'
export * from './settings.ts'
export * from './websocket.ts'

export const name = 'fi-provider-compat'

/** Longest interval a deployment may cache a live model listing for. */
const MAX_LIVE_MODEL_DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** How long a successful live listing is served before its route is interrogated again. */
const DEFAULT_LIVE_MODEL_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000

/** Subscription transport limits configured by the FI deployment. */
export interface Config {
  /** Maximum received Codex WebSocket message size in bytes. */
  websocketMaxPayloadBytes?: number
  /**
   * Whether Claude Code, Codex, and Grok subscription routes advertise the
   * live model ids their signed-in account can use, beyond pi-ai's installed
   * catalog for `anthropic`, `openai-codex`, and `xai`. Disabling it leaves
   * those three routes exactly as the installed catalog describes them.
   */
  liveModelDiscoveryEnabled?: boolean
  /**
   * How long a successful live listing is cached before its route is
   * interrogated again, in milliseconds. Listing or a subscription sign-in
   * may still trigger a fresh interrogation immediately after the previous
   * one expires; this is not a polling interval, since nothing here polls in
   * the background.
   */
  liveModelDiscoveryCacheTtlMs?: number
}

/** Reject unlimited, fractional, negative, or unsafe payload limits and cache intervals at plugin load. */
export const Config: z<Config> = z.object({
  websocketMaxPayloadBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(100 * 1024 * 1024),
  liveModelDiscoveryEnabled: z.boolean().default(true),
  liveModelDiscoveryCacheTtlMs: z.number().step(1).min(1_000).max(MAX_LIVE_MODEL_DISCOVERY_CACHE_TTL_MS)
    .default(DEFAULT_LIVE_MODEL_DISCOVERY_CACHE_TTL_MS),
})

function subscriptionProvider(provider: string): provider is SubscriptionProvider {
  return provider === 'anthropic' || provider === 'openai-codex' || provider === 'xai'
}

/** Resolve schema defaults before constructing a socket owner. */
function resolveConfig(config: Config): Required<Config> {
  return Config(config) as Required<Config>
}

/**
 * Register subscription-only pi-ai request transport metadata, and — unless
 * disabled — live model discovery for the same three subscription routes.
 * @param ctx - plugin context owning the listener and connector lifetime.
 * @param config - deployment payload limit and live-discovery knobs, resolved through the plugin schema.
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
  if (!resolved.liveModelDiscoveryEnabled) return
  // One set of caches per plugin instance: two mounts (or two tests) never
  // share a cached listing, and a mount's caches disappear with it.
  const caches = createLiveModelCaches(resolved.liveModelDiscoveryCacheTtlMs)
  ctx.on('llm-pi-ai/live-models', async (request, next) => {
    const downstream = await next()
    if (!subscriptionProvider(request.provider)) return downstream
    const live = await fetchLiveModels({ ...request, provider: request.provider }, caches)
    return [...downstream, ...live]
  })
}
