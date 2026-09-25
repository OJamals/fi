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

/** User-controlled provider preference and provider-specific options. */
export interface Config {
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
  ] as const).default(DEEPSEEK_PROVIDER_ID),
  exaApiKeyEnv: z.string().role('credential-ref').default(EXA_API_KEY_ENV),
  exaBaseURL: z.string().default(EXA_DEFAULT_BASE_URL),
  exaSearchType: z.union(['auto', 'keyword', 'neural'] as const).default(EXA_DEFAULT_SEARCH_TYPE),
  exaNumResults: z.number().step(1).min(1),
  exaHighlightsPerResult: z.number().step(1).min(1).default(EXA_DEFAULT_HIGHLIGHTS_PER_RESULT),
  perplexityApiKeyEnv: z.string().role('credential-ref').default(PERPLEXITY_API_KEY_ENV),
  perplexityBaseURL: z.string().default(PERPLEXITY_DEFAULT_BASE_URL),
  perplexityModel: z.string().default(PERPLEXITY_DEFAULT_MODEL),
  perplexityMaxTokens: z.number().step(1).min(1).default(PERPLEXITY_DEFAULT_MAX_TOKENS),
  perplexitySearchRecency: z.union(['day', 'week', 'month', 'year'] as const),
  parallelApiKeyEnv: z.string().role('credential-ref').default(PARALLEL_API_KEY_ENV),
  parallelBaseURL: z.string().default(PARALLEL_DEFAULT_BASE_URL),
  parallelMode: z.union(['turbo', 'fast', 'basic', 'advanced'] as const),
  tavilyApiKeyEnv: z.string().role('credential-ref').default(TAVILY_API_KEY_ENV),
  tavilyBaseURL: z.string().default(TAVILY_DEFAULT_BASE_URL),
  serperApiKeyEnv: z.string().role('credential-ref').default(SERPER_API_KEY_ENV),
  serperBaseURL: z.string().default(SERPER_DEFAULT_BASE_URL),
  braveApiKeyEnv: z.string().role('credential-ref').default(BRAVE_API_KEY_ENV),
  braveBaseURL: z.string().default(BRAVE_DEFAULT_BASE_URL),
  subscriptionProvider: z.union(['codex', 'grok', 'antigravity', 'claude'] as const),
  subscriptionModel: z.string(),
  subscriptionTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS),
  subscriptionMaxResponseBytes: z.number().step(1).min(1).default(DEFAULT_MAX_RESPONSE_BYTES),
  subscriptionMaxUses: z.number().step(1).min(1).default(DEFAULT_MAX_USES),
  subscriptionMaxOutputTokens: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_TOKENS),
})

/** Preferred-search settings; only legacy DeepSeek `apiKey` stores a literal credential. */
export const Config: z<Config> = z.intersect([DeepSeekConfigSchema, PreferredConfig])
