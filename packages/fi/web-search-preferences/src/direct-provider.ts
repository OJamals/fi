/** FI-local adapters for search APIs not shipped by upstream DeepSeek Harness. */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** Parallel Search API endpoint base. */
export const PARALLEL_DEFAULT_BASE_URL = 'https://api.parallel.ai'
/** Tavily API endpoint base. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'
/** Serper API endpoint base. */
export const SERPER_DEFAULT_BASE_URL = 'https://google.serper.dev'
/** Brave Search API endpoint base. */
export const BRAVE_DEFAULT_BASE_URL = 'https://api.search.brave.com/res'

const PROVIDER_NAMES = {
  parallel: 'Parallel',
  tavily: 'Tavily',
  serper: 'Serper',
  brave: 'Brave',
} as const

/** FI-local direct-provider ids. */
export type FiDirectSearchProviderId = keyof typeof PROVIDER_NAMES

/** Parallel Search API quality and latency preset. */
export type ParallelSearchMode = 'turbo' | 'fast' | 'basic' | 'advanced'

/** Resolved options for one FI-local direct provider. */
export interface FiDirectSearchProviderOptions {
  /** Selected provider protocol. */
  provider: FiDirectSearchProviderId
  /** Provider API key. */
  apiKey: string
  /** Provider endpoint base. */
  baseURL: string
  /** Optional Parallel mode; omission preserves Parallel's server default. */
  parallelMode?: ParallelSearchMode
}

const USER_AGENT = 'fi/0.1.5'

/**
 * Create one direct search adapter behind the upstream provider-neutral seam.
 * @param options - resolved provider protocol, credential, endpoint, and optional mode.
 * @returns provider implementing the upstream `WebSearchProvider` interface.
 */
export function createFiDirectSearchProvider(options: FiDirectSearchProviderOptions): WebSearchProvider {
  return new FiDirectSearchProvider(options)
}

class FiDirectSearchProvider implements WebSearchProvider {
  readonly id: FiDirectSearchProviderId

  constructor(private readonly options: FiDirectSearchProviderOptions) {
    this.id = options.provider
  }

  available(): boolean {
    return this.options.apiKey.length > 0 && isValidHttpsBase(this.options.baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (!this.available()) {
      throw new WebError(
        `${providerName(this.id)} search requires an API key and HTTPS endpoint`,
        'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
      )
    }
    const wire = requestFor(this.options, request, signal)
    let response: Response
    try {
      response = await fetch(wire.url, wire.init)
    } catch (error: unknown) {
      if (signal?.aborted || isAbortError(error)) throw aborted(this.id, signal?.reason ?? error)
      throw new WebError(
        `${providerName(this.id)} search request failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (signal?.aborted) throw aborted(this.id, signal.reason)
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw responseError(this.id, response)
    }
    try {
      return mapResponse(this.id, await response.json())
    } catch (error: unknown) {
      if (signal?.aborted || isAbortError(error)) throw aborted(this.id, signal?.reason ?? error)
      throw new WebError(
        `${providerName(this.id)} returned an invalid response body: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }
}

interface WireRequest {
  url: string
  init: RequestInit
}

function requestFor(
  options: FiDirectSearchProviderOptions,
  request: WebSearchRequest,
  signal?: AbortSignal,
): WireRequest {
  const commonHeaders = {
    'accept': 'application/json',
    'user-agent': USER_AGENT,
  }
  switch (options.provider) {
    case 'parallel':
      return jsonRequest(join(options.baseURL, '/v1/search'), {
        ...commonHeaders,
        'x-api-key': options.apiKey,
      }, {
        objective: request.query,
        search_queries: [request.query],
        ...options.parallelMode === undefined ? {} : { mode: options.parallelMode },
      }, signal)
    case 'tavily':
      return jsonRequest(join(options.baseURL, '/search'), {
        ...commonHeaders,
        'authorization': `Bearer ${options.apiKey}`,
      }, {
        query: request.query,
        ...request.maxResults === undefined ? {} : { max_results: request.maxResults },
      }, signal)
    case 'serper':
      return jsonRequest(join(options.baseURL, '/search'), {
        ...commonHeaders,
        'x-api-key': options.apiKey,
      }, {
        q: request.query,
        ...request.maxResults === undefined ? {} : { num: request.maxResults },
      }, signal)
    case 'brave': {
      const url = new URL(join(options.baseURL, '/v1/web/search'))
      url.searchParams.set('q', request.query)
      if (request.maxResults !== undefined) url.searchParams.set('count', String(request.maxResults))
      return {
        url: url.href,
        init: {
          method: 'GET',
          redirect: 'error',
          headers: { ...commonHeaders, 'x-subscription-token': options.apiKey },
          ...signal === undefined ? {} : { signal },
        },
      }
    }
    default:
      return assertNever(options.provider)
  }
}

function jsonRequest(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): WireRequest {
  return {
    url,
    init: {
      method: 'POST',
      redirect: 'error',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...signal === undefined ? {} : { signal },
    },
  }
}

function mapResponse(provider: FiDirectSearchProviderId, value: unknown): WebSearchResult {
  const payload = record(value, 'response')
  let sources: WebSearchSource[]
  switch (provider) {
    case 'parallel':
      sources = array(payload.results, 'results').map((item, index) => {
        const result = record(item, `results[${index}]`)
        return source(
          result.url,
          result.title,
          firstText(result.excerpts, `results[${index}].excerpts`),
          result.publish_date,
          `results[${index}]`,
        )
      })
      break
    case 'tavily':
      sources = array(payload.results, 'results').map((item, index) => {
        const result = record(item, `results[${index}]`)
        return source(result.url, result.title, result.content, result.published_date, `results[${index}]`)
      })
      break
    case 'serper':
      sources = optionalArray(payload.organic, 'organic').map((item, index) => {
        const result = record(item, `organic[${index}]`)
        return source(result.link, result.title, result.snippet, result.date, `organic[${index}]`)
      })
      break
    case 'brave': {
      const web = payload.web === undefined ? undefined : record(payload.web, 'web')
      sources = optionalArray(web?.results, 'web.results').map((item, index) => {
        const result = record(item, `web.results[${index}]`)
        return source(
          result.url,
          result.title,
          result.description,
          result.page_age,
          `web.results[${index}]`,
        )
      })
      break
    }
    default:
      return assertNever(provider)
  }
  return { sources, truncated: false }
}

function source(
  rawUrl: unknown,
  rawTitle: unknown,
  rawSnippet: unknown,
  rawPublishedAt: unknown,
  path: string,
): WebSearchSource {
  const url = requiredString(rawUrl, `${path}.url`)
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${path}.url must use HTTP or HTTPS`)
  }
  const title = optionalString(rawTitle, `${path}.title`)
  const snippet = optionalString(rawSnippet, `${path}.snippet`)
  const publishedAt = optionalString(rawPublishedAt, `${path}.publishedAt`)
  return {
    url,
    ...title === undefined || title.length === 0 ? {} : { title },
    ...snippet === undefined || snippet.length === 0 ? {} : { snippet },
    ...publishedAt === undefined || publishedAt.length === 0 ? {} : { publishedAt },
  }
}

function firstText(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return array(value, path).map((item, index) => requiredString(item, `${path}[${index}]`))
    .find(item => item.trim().length > 0)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
  return value
}

function optionalArray(value: unknown, path: string): unknown[] {
  return value === undefined || value === null ? [] : array(value, path)
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${path} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`${path} must be a string`)
  return value
}

function responseError(provider: FiDirectSearchProviderId, response: Response): WebError {
  return new WebError(
    `${providerName(provider)} API error (HTTP ${response.status})`,
    'WEB_PROVIDER_ERROR',
  )
}

function providerName(provider: FiDirectSearchProviderId): string {
  return PROVIDER_NAMES[provider]
}

function join(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}${path}`
}

function isValidHttpsBase(value: string): boolean {
  if (!URL.canParse(value)) return false
  return new URL(value).protocol === 'https:'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function aborted(provider: FiDirectSearchProviderId, cause: unknown): WebError {
  return new WebError(`${providerName(provider)} search aborted`, 'WEB_ABORTED', { cause })
}

function assertNever(value: never): never {
  throw new WebError(`unsupported FI direct search provider "${String(value)}"`, 'WEB_PROVIDER_ERROR')
}
