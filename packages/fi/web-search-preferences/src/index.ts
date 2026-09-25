/** FI preferred search plugin: durable user selection over unchanged upstream providers. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_PROVIDER_ID,
  DeepSeekSearchProvider,
} from '@deepseek-ai/dsh-web-search-deepseek'
import {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_PROVIDER_ID,
  ExaSearchProvider,
} from '@deepseek-ai/dsh-web-search-exa'
import {
  PERPLEXITY_DEFAULT_BASE_URL,
  PERPLEXITY_DEFAULT_MAX_TOKENS,
  PERPLEXITY_DEFAULT_MODEL,
  PERPLEXITY_PROVIDER_ID,
  PerplexitySearchProvider,
} from '@deepseek-ai/dsh-web-search-perplexity'
import {
  createSubscriptionSearchProvider,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_USES,
  DEFAULT_TIMEOUT_MS,
} from '@fi/web-search-subscription'
import {
  BRAVE_DEFAULT_BASE_URL,
  createFiDirectSearchProvider,
  PARALLEL_DEFAULT_BASE_URL,
  SERPER_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_BASE_URL,
} from './direct-provider.ts'
import {
  PreferredSearchProvider,
  type ResolvedSearchProvider,
} from './provider.ts'
import { Config as ConfigSchema, type Config } from './types.ts'

export {
  FI_PREFERRED_SEARCH_PROVIDER_ID,
  PreferredSearchProvider,
} from './provider.ts'
export type {
  PreferredSearchProviderOptions,
  ResolvedSearchProvider,
} from './provider.ts'
export { Config } from './types.ts'
export type { PreferredSearchProviderId } from './types.ts'
export {
  BRAVE_DEFAULT_BASE_URL,
  createFiDirectSearchProvider,
  PARALLEL_DEFAULT_BASE_URL,
  SERPER_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_BASE_URL,
} from './direct-provider.ts'
export type {
  FiDirectSearchProviderId,
  FiDirectSearchProviderOptions,
  ParallelSearchMode,
} from './direct-provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fi-web-search-preferences'

/** Upstream DeepSeek namespace extended in place so FI activation and removal preserve settings. */
export const WEB_SEARCH_PREFERENCES_SETTINGS_NAMESPACE = 'web-search-deepseek'

/** Required registry service; settings and credentials remain optional seams. */
export const inject = ['web']

const DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEEPSEEK_SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'
const EXA_API_KEY_ENV = 'EXA_API_KEY'
const PERPLEXITY_API_KEY_ENV = 'PERPLEXITY_API_KEY'
const PARALLEL_API_KEY_ENV = 'PARALLEL_API_KEY'
const TAVILY_API_KEY_ENV = 'TAVILY_API_KEY'
const SERPER_API_KEY_ENV = 'SERPER_API_KEY'
const BRAVE_API_KEY_ENV = 'BRAVE_SEARCH_API_KEY'

function assertCredentialResolutionActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WebError('web search credential resolution aborted', 'WEB_ABORTED')
  }
}

/** Resolve one credential without retaining its value on the stable router. */
async function resolveCredential(ctx: Context, refName: string, signal: AbortSignal): Promise<string> {
  assertCredentialResolutionActive(signal)
  const ref = credentialRef(refName)
  const credentials = ctx.get('credentials')
  const value = credentials === undefined
    ? launchEnvironmentOf(ctx).get(ref)?.value
    : (await credentials.resolve(ref))?.value
  assertCredentialResolutionActive(signal)
  if (value !== undefined && value.length > 0) return value
  throw new WebError(
    `preferred web search has no API key for "${ref}"; store it through the credentials service or launching environment`,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/**
 * Build the selected upstream provider from one operation's settings snapshot.
 * @param ctx - context supplying credentials, launch environment, agents, and subscription grants.
 * @param config - frozen settings snapshot for this operation.
 * @param signal - combined caller and plugin-lifecycle cancellation.
 * @returns selected operation-scoped provider.
 */
export async function resolveSelectedProvider(
  ctx: Context,
  config: Config,
  signal: AbortSignal,
): Promise<ResolvedSearchProvider> {
  switch (config.provider) {
    case DEEPSEEK_PROVIDER_ID: {
      const baseURL = requireHttpsEndpoint(
        'DeepSeek',
        config.baseURL
          ?? launchEnvironmentOf(ctx).get(DEEPSEEK_SEARCH_BASE_URL_ENV)?.value
          ?? DEEPSEEK_DEFAULT_BASE_URL,
      )
      const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEEPSEEK_API_KEY_ENV)
      const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
        ? config.apiKey
        : undefined
      return new DeepSeekSearchProvider(() => ({
        ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
        resolveApiKey: async () => resolveCredential(ctx, apiKeyEnv, signal),
        apiKeyEnv,
        baseURL,
        model: config.model ?? DEEPSEEK_DEFAULT_MODEL,
        apiVersion: config.apiVersion ?? DEEPSEEK_DEFAULT_API_VERSION,
        maxTokens: config.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS,
        maxUses: config.maxUses ?? DEEPSEEK_DEFAULT_MAX_USES,
        recordRequest: (request) => {
          ctx.get('agents')?.currentInitiator()?.session.append('web/deepseek-search-llm-request', request)
        },
      }))
    }
    case EXA_PROVIDER_ID: {
      const baseURL = requireHttpsEndpoint('Exa', config.exaBaseURL ?? EXA_DEFAULT_BASE_URL)
      return new ExaSearchProvider({
        apiKey: await resolveCredential(ctx, config.exaApiKeyEnv ?? EXA_API_KEY_ENV, signal),
        baseURL,
        searchType: config.exaSearchType ?? EXA_DEFAULT_SEARCH_TYPE,
        highlightsPerResult: config.exaHighlightsPerResult ?? EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
        ...config.exaNumResults === undefined ? {} : { numResults: config.exaNumResults },
      })
    }
    case PERPLEXITY_PROVIDER_ID: {
      const baseURL = requireHttpsEndpoint(
        'Perplexity',
        config.perplexityBaseURL ?? PERPLEXITY_DEFAULT_BASE_URL,
      )
      return new PerplexitySearchProvider({
        apiKey: await resolveCredential(ctx, config.perplexityApiKeyEnv ?? PERPLEXITY_API_KEY_ENV, signal),
        baseURL,
        model: config.perplexityModel ?? PERPLEXITY_DEFAULT_MODEL,
        maxTokens: config.perplexityMaxTokens ?? PERPLEXITY_DEFAULT_MAX_TOKENS,
        ...config.perplexitySearchRecency === undefined
          ? {}
          : { searchRecency: config.perplexitySearchRecency },
      })
    }
    case 'parallel': {
      const baseURL = requireHttpsEndpoint('Parallel', config.parallelBaseURL ?? PARALLEL_DEFAULT_BASE_URL)
      return createFiDirectSearchProvider({
        provider: 'parallel',
        apiKey: await resolveCredential(ctx, config.parallelApiKeyEnv ?? PARALLEL_API_KEY_ENV, signal),
        baseURL,
        ...config.parallelMode === undefined ? {} : { parallelMode: config.parallelMode },
      })
    }
    case 'tavily': {
      const baseURL = requireHttpsEndpoint('Tavily', config.tavilyBaseURL ?? TAVILY_DEFAULT_BASE_URL)
      return createFiDirectSearchProvider({
        provider: 'tavily',
        apiKey: await resolveCredential(ctx, config.tavilyApiKeyEnv ?? TAVILY_API_KEY_ENV, signal),
        baseURL,
      })
    }
    case 'serper': {
      const baseURL = requireHttpsEndpoint('Serper', config.serperBaseURL ?? SERPER_DEFAULT_BASE_URL)
      return createFiDirectSearchProvider({
        provider: 'serper',
        apiKey: await resolveCredential(ctx, config.serperApiKeyEnv ?? SERPER_API_KEY_ENV, signal),
        baseURL,
      })
    }
    case 'brave': {
      const baseURL = requireHttpsEndpoint('Brave', config.braveBaseURL ?? BRAVE_DEFAULT_BASE_URL)
      return createFiDirectSearchProvider({
        provider: 'brave',
        apiKey: await resolveCredential(ctx, config.braveApiKeyEnv ?? BRAVE_API_KEY_ENV, signal),
        baseURL,
      })
    }
    case 'subscription-native':
      if (
        config.subscriptionProvider === undefined
        || config.subscriptionModel === undefined
        || config.subscriptionModel.trim() === ''
      ) {
        throw new WebError(
          'subscription-native search requires subscriptionProvider and subscriptionModel',
          'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
        )
      }
      return createSubscriptionSearchProvider(ctx, {
        provider: config.subscriptionProvider,
        model: config.subscriptionModel.trim(),
        timeoutMs: config.subscriptionTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxResponseBytes: config.subscriptionMaxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        maxUses: config.subscriptionMaxUses ?? DEFAULT_MAX_USES,
        maxOutputTokens: config.subscriptionMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      })
    default:
      return assertNever(config.provider)
  }
}

function requireHttpsEndpoint(provider: string, value: string): string {
  if (URL.canParse(value) && new URL(value).protocol === 'https:') return value
  throw new WebError(
    `${provider} search requires an HTTPS endpoint`,
    'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
  )
}

function assertNever(value: never): never {
  throw new WebError(`unsupported preferred web search provider "${String(value)}"`, 'WEB_PROVIDER_ERROR')
}

/**
 * Register one stable router and install its live settings section when available.
 * @param ctx - Cordis context supplying the web registry and optional settings service.
 * @param config - composition-layer preferred-search settings.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(
      ctx,
      WEB_SEARCH_PREFERENCES_SETTINGS_NAMESPACE,
      ConfigSchema,
      config,
      {
        setSource: (source) => { current = source },
        onChange: () => {},
      },
    )
  })
  const preferred = new PreferredSearchProvider({
    resolveConfig: () => current(),
    resolveProvider: (snapshot, signal) => resolveSelectedProvider(ctx, snapshot, signal),
  })
  ctx.web.registerSearchProvider(preferred)
  ctx.effect(() => async () => { await preferred.dispose() }, `${name}:active-searches`)
}
