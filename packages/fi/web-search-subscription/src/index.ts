/** Opt-in native web search through stored provider subscription grants. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createModels } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type {} from '@deepseek-ai/dsh-web'
import { authContextFrom, credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveAntigravityGrant } from '@fi/llm-antigravity'
import { callAntigravityGeminiNative } from '@fi/llm-antigravity/transport'
import { SubscriptionSearchProvider } from './provider.ts'
import type { SubscriptionSearchFamily } from './types.ts'

export { SUBSCRIPTION_SEARCH_PROVIDER_ID, SubscriptionSearchProvider } from './provider.ts'
export type { SubscriptionSearchProviderOptions } from './provider.ts'
export { SubscriptionSearchError } from './types.ts'
export type { SubscriptionSearchFamily } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fi-web-search-subscription'

/** Native search consumes the web registry and stored subscription grants. */
export const inject = ['web', 'credentials']

/** Default whole-operation timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000
/** Largest configurable whole-operation timeout in milliseconds. */
export const MAX_TIMEOUT_MS = 120_000
/** Default maximum retained response bytes. */
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
/** Largest configurable retained response size in bytes. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
/** Default maximum accepted native search-action count. */
export const DEFAULT_MAX_USES = 5
/** Largest configurable native search-action count. */
export const MAX_USES = 10
/** Default generated-answer token request for transports that expose one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 512
/** Largest configurable generated-answer token request. */
export const MAX_OUTPUT_TOKENS = 8_192

/** Explicit native-subscription search selection and resource limits. */
export interface Config {
  /** Subscription family; required because no account or provider is auto-selected. */
  provider: SubscriptionSearchFamily
  /** Exact upstream model id; required because the package does not choose a model. */
  model: string
  /** Whole-operation timeout in milliseconds. */
  timeoutMs?: number
  /** Maximum retained UTF-8 response bytes. */
  maxResponseBytes?: number
  /** Maximum native search actions accepted from one response. */
  maxUses?: number
  /** Maximum generated answer tokens requested from the search model. */
  maxOutputTokens?: number
}

export const Config: z<Config> = z.object({
  provider: z.union(['codex', 'grok', 'antigravity', 'claude'] as const).required(),
  model: z.string().required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  maxResponseBytes: z.number().step(1).min(1).max(MAX_RESPONSE_BYTES).default(DEFAULT_MAX_RESPONSE_BYTES),
  maxUses: z.number().step(1).min(1).max(MAX_USES).default(DEFAULT_MAX_USES),
  maxOutputTokens: z.number().step(1).min(1).max(MAX_OUTPUT_TOKENS).default(DEFAULT_MAX_OUTPUT_TOKENS),
})

/**
 * Create one explicitly configured subscription-native provider without registering it.
 * @param ctx - context supplying stored OAuth grants and Antigravity transport.
 * @param config - explicit subscription family, model, and resource limits.
 * @returns provider ready for one owner to register or delegate through.
 */
export function createSubscriptionSearchProvider(ctx: Context, config: Config): SubscriptionSearchProvider {
  const models = createModels({
    credentials: credentialStoreFrom(ctx),
    authContext: authContextFrom(ctx),
  })
  for (const provider of builtinProviders()) models.setProvider(provider)
  return new SubscriptionSearchProvider({
    provider: config.provider,
    model: config.model,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    maxUses: config.maxUses ?? DEFAULT_MAX_USES,
    maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    resolveOAuth: (provider, signal) => models.getAuth(provider, { signal }),
    resolveAntigravityGrant: signal => resolveAntigravityGrant(ctx, signal),
    callAntigravity: callAntigravityGeminiNative,
  })
}

/** Register one explicitly configured subscription-native search provider. */
export function apply(ctx: Context, config: Config): void {
  const search = createSubscriptionSearchProvider(ctx, config)
  ctx.web.registerSearchProvider(search)
  ctx.effect(function* () {
    yield async () => { await search.dispose() }
  }, `${name}:active-requests`)
}
