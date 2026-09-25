/**
 * Exa-backed `WebSearchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service.
 *
 * @module @deepseek-ai/dsh-web-search-exa
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  ExaSearchProvider,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
} from './provider.ts'
import type { ExaSearchProviderOptions } from './provider.ts'

export {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_PROVIDER_ID,
  ExaSearchProvider,
} from './provider.ts'
export type { ExaSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-exa'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'EXA_API_KEY'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Exa API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each search; defaults to `EXA_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Retrieval mode sent as Exa's `type`. Defaults to `auto`. */
  searchType?: 'auto' | 'keyword' | 'neural'
  /** Default result count when a request carries no `maxResults`. Omitted = none. */
  numResults?: number
  /** Highlight sentences requested per result. Defaults to 1. */
  highlightsPerResult?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  searchType: z.union(['auto', 'keyword', 'neural'] as const),
  numResults: z.number().step(1).min(1),
  highlightsPerResult: z.number().step(1).min(1),
})

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): ExaSearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    // The resolveApiKey shape is intentionally identical across every
    // web-search-* plugin's resolveOptions (deepseek/exa/perplexity): same
    // credentials-then-ambient-environment fallback, different provider name.
    /* jscpd:ignore-start */
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    /* jscpd:ignore-end */
    apiKeyEnv,
    baseURL: config.baseURL ?? EXA_DEFAULT_BASE_URL,
    searchType: config.searchType ?? EXA_DEFAULT_SEARCH_TYPE,
    highlightsPerResult: config.highlightsPerResult ?? EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
    ...config.numResults !== undefined ? { numResults: config.numResults } : {},
  }
}

/** Register the Exa search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new ExaSearchProvider(() => resolveOptions(ctx, config)))
}
