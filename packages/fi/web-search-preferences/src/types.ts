/** Settings schema for FI preferred search routing. */

import {
  Config as DeepSeekConfigSchema,
  DEEPSEEK_PROVIDER_ID,
} from '@deepseek-ai/dsh-web-search-deepseek'
import {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_PROVIDER_ID,
} from '@deepseek-ai/dsh-web-search-exa'
import {
  PERPLEXITY_DEFAULT_BASE_URL,
  PERPLEXITY_DEFAULT_MAX_TOKENS,
  PERPLEXITY_DEFAULT_MODEL,
  PERPLEXITY_PROVIDER_ID,
  type PerplexityRecency,
} from '@deepseek-ai/dsh-web-search-perplexity'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_USES,
  DEFAULT_TIMEOUT_MS,
  type SubscriptionSearchFamily,
} from '@fi/web-search-subscription'
import {
  BRAVE_DEFAULT_BASE_URL,
  PARALLEL_DEFAULT_BASE_URL,
  SERPER_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_BASE_URL,
  type ParallelSearchMode,
} from './direct-provider.ts'

const EXA_API_KEY_ENV = 'EXA_API_KEY'
const PERPLEXITY_API_KEY_ENV = 'PERPLEXITY_API_KEY'
const PARALLEL_API_KEY_ENV = 'PARALLEL_API_KEY'
const TAVILY_API_KEY_ENV = 'TAVILY_API_KEY'
const SERPER_API_KEY_ENV = 'SERPER_API_KEY'
const BRAVE_API_KEY_ENV = 'BRAVE_SEARCH_API_KEY'

/** Upstream and FI-owned provider ids selectable by the preference router. */
export type PreferredSearchProviderId =
  | 'deepseek-official'
  | 'exa'
  | 'perplexity'
  | 'parallel'
  | 'tavily'
  | 'serper'
  | 'brave'
  | 'subscription-native'

/** One operation's snapshot of the provider preference and provider-specific options. */
export interface PreferredSearchSettings {
  /** Provider used by the next search operation. */
  provider: PreferredSearchProviderId
  /** Legacy literal DeepSeek key; retained only for upstream settings compatibility. */
  apiKey?: string
  /** DeepSeek credential reference, preserving the upstream field name. */
  apiKeyEnv?: string
  /** DeepSeek Anthropic-compatible endpoint base, preserving the upstream field name. */
  baseURL?: string
  /** DeepSeek search model, preserving the upstream field name. */
  model?: string
  /** DeepSeek Anthropic protocol version, preserving the upstream field name. */
  apiVersion?: string
  /** DeepSeek generated-token limit, preserving the upstream field name. */
  maxTokens?: number
  /** DeepSeek native search-action limit, preserving the upstream field name. */
  maxUses?: number
  /** Credential reference for Exa. */
  exaApiKeyEnv?: string
  /** Exa endpoint base. */
  exaBaseURL?: string
  /** Exa retrieval mode. */
  exaSearchType?: 'auto' | 'keyword' | 'neural'
  /** Exa default result count. */
  exaNumResults?: number
  /** Exa highlight sentences requested per result. */
  exaHighlightsPerResult?: number
  /** Credential reference for Perplexity. */
  perplexityApiKeyEnv?: string
  /** Perplexity endpoint base. */
  perplexityBaseURL?: string
  /** Perplexity search model. */
  perplexityModel?: string
  /** Perplexity answer-token limit. */
  perplexityMaxTokens?: number
  /** Perplexity recency filter. */
  perplexitySearchRecency?: PerplexityRecency
  /** Credential reference for Parallel. */
  parallelApiKeyEnv?: string
  /** Parallel endpoint base. */
  parallelBaseURL?: string
  /** Parallel Search API quality and latency preset. */
  parallelMode?: ParallelSearchMode
  /** Credential reference for Tavily. */
  tavilyApiKeyEnv?: string
  /** Tavily endpoint base. */
  tavilyBaseURL?: string
  /** Credential reference for Serper. */
  serperApiKeyEnv?: string
  /** Serper endpoint base. */
  serperBaseURL?: string
  /** Credential reference for Brave Search. */
  braveApiKeyEnv?: string
  /** Brave Search endpoint base. */
  braveBaseURL?: string
  /** Stored-grant family used by subscription-native search. */
  subscriptionProvider?: SubscriptionSearchFamily
  /** Exact model id for subscription-native search. */
  subscriptionModel?: string
  /** Subscription operation timeout. */
  subscriptionTimeoutMs?: number
  /** Subscription response byte limit. */
  subscriptionMaxResponseBytes?: number
  /** Subscription native search-action limit. */
  subscriptionMaxUses?: number
  /** Subscription generated-token limit. */
  subscriptionMaxOutputTokens?: number
}

const PreferredConfig = z.object({
  provider: z.union([
    DEEPSEEK_PROVIDER_ID,
    EXA_PROVIDER_ID,
    PERPLEXITY_PROVIDER_ID,
    'parallel',
    'tavily',
    'serper',
    'brave',
    'subscription-native',
  ] as const).default(DEEPSEEK_PROVIDER_ID).volatile(),
  exaApiKeyEnv: z.string().role('credential-ref').default(EXA_API_KEY_ENV).volatile(),
  exaBaseURL: z.string().default(EXA_DEFAULT_BASE_URL).volatile(),
  exaSearchType: z.union(['auto', 'keyword', 'neural'] as const).default(EXA_DEFAULT_SEARCH_TYPE).volatile(),
  exaNumResults: z.number().step(1).min(1).volatile(),
  exaHighlightsPerResult: z.number().step(1).min(1).default(EXA_DEFAULT_HIGHLIGHTS_PER_RESULT).volatile(),
  perplexityApiKeyEnv: z.string().role('credential-ref').default(PERPLEXITY_API_KEY_ENV).volatile(),
  perplexityBaseURL: z.string().default(PERPLEXITY_DEFAULT_BASE_URL).volatile(),
  perplexityModel: z.string().default(PERPLEXITY_DEFAULT_MODEL).volatile(),
  perplexityMaxTokens: z.number().step(1).min(1).default(PERPLEXITY_DEFAULT_MAX_TOKENS).volatile(),
  perplexitySearchRecency: z.union(['day', 'week', 'month', 'year'] as const).volatile(),
  parallelApiKeyEnv: z.string().role('credential-ref').default(PARALLEL_API_KEY_ENV).volatile(),
  parallelBaseURL: z.string().default(PARALLEL_DEFAULT_BASE_URL).volatile(),
  parallelMode: z.union(['turbo', 'fast', 'basic', 'advanced'] as const).volatile(),
  tavilyApiKeyEnv: z.string().role('credential-ref').default(TAVILY_API_KEY_ENV).volatile(),
  tavilyBaseURL: z.string().default(TAVILY_DEFAULT_BASE_URL).volatile(),
  serperApiKeyEnv: z.string().role('credential-ref').default(SERPER_API_KEY_ENV).volatile(),
  serperBaseURL: z.string().default(SERPER_DEFAULT_BASE_URL).volatile(),
  braveApiKeyEnv: z.string().role('credential-ref').default(BRAVE_API_KEY_ENV).volatile(),
  braveBaseURL: z.string().default(BRAVE_DEFAULT_BASE_URL).volatile(),
  subscriptionProvider: z.union(['codex', 'grok', 'antigravity', 'claude'] as const).volatile(),
  subscriptionModel: z.string().volatile(),
  subscriptionTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS).volatile(),
  subscriptionMaxResponseBytes: z.number().step(1).min(1).default(DEFAULT_MAX_RESPONSE_BYTES).volatile(),
  subscriptionMaxUses: z.number().step(1).min(1).default(DEFAULT_MAX_USES).volatile(),
  subscriptionMaxOutputTokens: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_TOKENS).volatile(),
})

/** Plugin Config: every field is volatile, so the profile-backed settings form edits it live. */
export interface Config {
  /** Provider used by the next search operation. */
  provider: Volatile<PreferredSearchProviderId>
  /** Legacy literal DeepSeek key; retained only for upstream settings compatibility. */
  apiKey: Volatile<string | undefined>
  /** DeepSeek credential reference, preserving the upstream field name. */
  apiKeyEnv: Volatile<string | undefined>
  /** DeepSeek Anthropic-compatible endpoint base, preserving the upstream field name. */
  baseURL: Volatile<string | undefined>
  /** DeepSeek search model, preserving the upstream field name. */
  model: Volatile<string | undefined>
  /** DeepSeek Anthropic protocol version, preserving the upstream field name. */
  apiVersion: Volatile<string | undefined>
  /** DeepSeek generated-token limit, preserving the upstream field name. */
  maxTokens: Volatile<number | undefined>
  /** DeepSeek native search-action limit, preserving the upstream field name. */
  maxUses: Volatile<number | undefined>
  /** Credential reference for Exa. */
  exaApiKeyEnv: Volatile<string | undefined>
  /** Exa endpoint base. */
  exaBaseURL: Volatile<string | undefined>
  /** Exa retrieval mode. */
  exaSearchType: Volatile<'auto' | 'keyword' | 'neural' | undefined>
  /** Exa default result count. */
  exaNumResults: Volatile<number | undefined>
  /** Exa highlight sentences requested per result. */
  exaHighlightsPerResult: Volatile<number | undefined>
  /** Credential reference for Perplexity. */
  perplexityApiKeyEnv: Volatile<string | undefined>
  /** Perplexity endpoint base. */
  perplexityBaseURL: Volatile<string | undefined>
  /** Perplexity search model. */
  perplexityModel: Volatile<string | undefined>
  /** Perplexity answer-token limit. */
  perplexityMaxTokens: Volatile<number | undefined>
  /** Perplexity recency filter. */
  perplexitySearchRecency: Volatile<PerplexityRecency | undefined>
  /** Credential reference for Parallel. */
  parallelApiKeyEnv: Volatile<string | undefined>
  /** Parallel endpoint base. */
  parallelBaseURL: Volatile<string | undefined>
  /** Parallel Search API quality and latency preset. */
  parallelMode: Volatile<ParallelSearchMode | undefined>
  /** Credential reference for Tavily. */
  tavilyApiKeyEnv: Volatile<string | undefined>
  /** Tavily endpoint base. */
  tavilyBaseURL: Volatile<string | undefined>
  /** Credential reference for Serper. */
  serperApiKeyEnv: Volatile<string | undefined>
  /** Serper endpoint base. */
  serperBaseURL: Volatile<string | undefined>
  /** Credential reference for Brave Search. */
  braveApiKeyEnv: Volatile<string | undefined>
  /** Brave Search endpoint base. */
  braveBaseURL: Volatile<string | undefined>
  /** Stored-grant family used by subscription-native search. */
  subscriptionProvider: Volatile<SubscriptionSearchFamily | undefined>
  /** Exact model id for subscription-native search. */
  subscriptionModel: Volatile<string | undefined>
  /** Subscription operation timeout. */
  subscriptionTimeoutMs: Volatile<number | undefined>
  /** Subscription response byte limit. */
  subscriptionMaxResponseBytes: Volatile<number | undefined>
  /** Subscription native search-action limit. */
  subscriptionMaxUses: Volatile<number | undefined>
  /** Subscription generated-token limit. */
  subscriptionMaxOutputTokens: Volatile<number | undefined>
}

/**
 * Preferred-search settings; only legacy DeepSeek `apiKey` stores a literal
 * credential. Merged as one flat object rather than `z.intersect`: every
 * field here is volatile, and a volatile field nested inside an intersect
 * member has no fixed object path, which schemastery's volatile-schema
 * validator rejects outright.
 */
export const Config = z.object({ ...DeepSeekConfigSchema.dict, ...PreferredConfig.dict }) as unknown as z<Config>

/**
 * Read every volatile field once for one operation.
 * @param config - live plugin Config.
 * @returns a plain snapshot that omits unset fields.
 */
export function snapshotConfig(config: Config): PreferredSearchSettings {
  const snapshot: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(config) as [string, Volatile<unknown>][]) {
    const value = field.get()
    if (value !== undefined) snapshot[key] = value
  }
  return snapshot as unknown as PreferredSearchSettings
}
