/** Native subscription transports normalized into the Harness web search result. */

import type { AuthResult, FetchFunction } from '@earendil-works/pi-ai'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import type { AntigravityGrant } from '@fi/llm-antigravity'
import type { GeminiNativeCallContext } from '@fi/llm-antigravity/transport'
import {
  authorizationHeaders,
  subscriptionEndpoint,
  subscriptionHeaders,
  type SubscriptionProvider,
} from '@fi/provider-compat'
import { parseAntigravitySearch, parseClaudeSearch, parseResponsesSearch, readBoundedText } from './response.ts'
import { SubscriptionSearchError, type SubscriptionSearchFamily } from './types.ts'

/** Stable id selected by `ctx.web` when this plugin is mounted. */
export const SUBSCRIPTION_SEARCH_PROVIDER_ID = 'subscription-native'

const HARNESS_USER_AGENT = '@fi/web-search-subscription/0.1.0-preview.4'

/** Fully resolved deployment limits and explicit provider selection. */
export interface SubscriptionSearchProviderOptions {
  readonly provider: SubscriptionSearchFamily
  readonly model: string
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly maxUses: number
  readonly maxOutputTokens: number
  readonly resolveOAuth: (provider: 'openai-codex' | 'xai' | 'anthropic', signal: AbortSignal) => Promise<AuthResult | undefined>
  readonly resolveAntigravityGrant: (signal: AbortSignal) => Promise<AntigravityGrant | undefined>
  readonly callAntigravity: (options: GeminiNativeCallContext) => Promise<Response>
  readonly fetch?: FetchFunction
  readonly sessionId?: () => string
}

function oauthProvider(provider: Exclude<SubscriptionSearchFamily, 'antigravity'>): SubscriptionProvider {
  if (provider === 'codex') return 'openai-codex'
  if (provider === 'grok') return 'xai'
  return 'anthropic'
}

function combinedSignal(
  caller: AbortSignal | undefined,
  lifecycle: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; timeout: AbortController; clear: () => void } {
  const timeout = new AbortController()
  const timer = setTimeout(() => {
    timeout.abort(new Error('subscription search timed out'))
  }, timeoutMs)
  return {
    signal: AbortSignal.any(caller === undefined
      ? [lifecycle, timeout.signal]
      : [caller, lifecycle, timeout.signal]),
    timeout,
    clear: () => { clearTimeout(timer) },
  }
}

/** One explicitly configured subscription-native search provider. */
export class SubscriptionSearchProvider implements WebSearchProvider {
  readonly id = SUBSCRIPTION_SEARCH_PROVIDER_ID
  private readonly lifecycle = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly options: SubscriptionSearchProviderOptions) {}

  /** This local check never reads credentials or performs network I/O. */
  available(): boolean {
    return !this.disposed
  }

  /**
   * Resolve one grant, freeze it, dispatch native search, and normalize only native citations.
   * @param request - query and optional normalized source limit.
   * @param callerSignal - caller cancellation propagated through auth resolution, dispatch, and response reading.
   * @returns the provider answer and native citation sources.
   */
  search(request: WebSearchRequest, callerSignal?: AbortSignal): Promise<WebSearchResult> {
    if (this.disposed) {
      return Promise.reject(new SubscriptionSearchError('subscription search provider is disposed', 'WEB_ABORTED'))
    }
    const operation = this.run(request, callerSignal)
    this.active.add(operation)
    void operation.finally(() => this.active.delete(operation)).catch(() => {})
    return operation
  }

  /** Abort and await every active request so effect disposal is quiescent. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = Promise.allSettled([...this.active]).then(() => {})
    this.lifecycle.abort(new Error('subscription search provider disposed'))
    return this.disposal
  }

  private async run(request: WebSearchRequest, callerSignal?: AbortSignal): Promise<WebSearchResult> {
    const operation = combinedSignal(callerSignal, this.lifecycle.signal, this.options.timeoutMs)
    try {
      if (this.options.provider === 'antigravity') return await this.searchAntigravity(request, operation.signal)
      return await this.searchOAuth(request, operation.signal)
    } catch (error) {
      if (error instanceof SubscriptionSearchError) throw error
      if (callerSignal?.aborted || this.lifecycle.signal.aborted) {
        throw new SubscriptionSearchError('subscription search was aborted', 'WEB_ABORTED', undefined, { cause: error })
      }
      if (operation.timeout.signal.aborted) {
        throw new SubscriptionSearchError('subscription search timed out', 'WEB_PROVIDER_TIMEOUT', undefined, { cause: error })
      }
      throw new SubscriptionSearchError('subscription search request failed', 'WEB_PROVIDER_ERROR', undefined, { cause: error })
    } finally {
      operation.clear()
    }
  }

  private async searchOAuth(request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchResult> {
    const family = this.options.provider as Exclude<SubscriptionSearchFamily, 'antigravity'>
    const provider = oauthProvider(family)
    const resolution = await this.options.resolveOAuth(provider, signal)
    if (resolution?.source !== 'OAuth') {
      throw new SubscriptionSearchError(
        `${family} subscription search requires a stored OAuth grant`,
        'WEB_PROVIDER_SUBSCRIPTION_OAUTH_REQUIRED',
      )
    }
    if (typeof resolution.auth.apiKey !== 'string' || resolution.auth.apiKey.length === 0) {
      throw new SubscriptionSearchError(
        `${family} OAuth resolution did not return an access token`,
        'WEB_PROVIDER_SUBSCRIPTION_OAUTH_REQUIRED',
      )
    }
    const frozenAuth = Object.freeze({
      ...resolution.auth,
      headers: Object.freeze({ ...resolution.auth.headers }),
    })
    const headers = subscriptionHeaders(
      provider,
      this.options.model,
      this.options.sessionId?.() ?? randomUUID(),
      this.options.timeoutMs,
      { ...authorizationHeaders(frozenAuth), 'User-Agent': HARNESS_USER_AGENT },
    )
    const responsesBody = family === 'codex'
      ? {
        model: this.options.model,
        instructions: '',
        input: [{ role: 'user', content: [{ type: 'input_text', text: request.query }] }],
        tools: [{ type: 'web_search' }],
        stream: true,
        store: false,
      }
      : {
        model: this.options.model,
        input: [{ role: 'user', content: request.query }],
        tools: [{ type: 'web_search' }],
        max_output_tokens: this.options.maxOutputTokens,
        stream: true,
        store: false,
      }
    const init: RequestInit = {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...headers,
        Accept: family === 'claude' ? 'application/json' : 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(family === 'claude'
        ? {
          model: this.options.model,
          max_tokens: this.options.maxOutputTokens,
          messages: [{ role: 'user', content: request.query }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: this.options.maxUses }],
        }
        : responsesBody),
      signal,
    }
    const endpoint = family === 'claude'
      ? `${subscriptionEndpoint(provider)}?beta=true`
      : subscriptionEndpoint(provider)
    const response = await (this.options.fetch ?? globalThis.fetch)(endpoint, init)
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new SubscriptionSearchError(
        `${family} subscription search failed with HTTP ${response.status}`,
        'WEB_PROVIDER_UPSTREAM_ERROR',
        response.status,
      )
    }
    const body = await readBoundedText(response, this.options.maxResponseBytes, signal)
    const normalized = family === 'claude'
      ? parseClaudeSearch(body, this.options.maxUses)
      : parseResponsesSearch(body, family === 'codex' ? 'Codex' : 'Grok', this.options.maxUses)
    return capResults(normalized, request.maxResults)
  }

  private async searchAntigravity(request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchResult> {
    const grant = await this.options.resolveAntigravityGrant(signal)
    if (grant === undefined) {
      throw new SubscriptionSearchError(
        'Antigravity subscription search requires a stored OAuth grant',
        'WEB_PROVIDER_SUBSCRIPTION_OAUTH_REQUIRED',
      )
    }
    const frozenGrant = Object.freeze({ ...grant })
    const response = await this.options.callAntigravity({
      action: 'generateContent',
      model: this.options.model,
      account: {
        token: {
          accessToken: frozenGrant.accessToken,
          ...(frozenGrant.projectId === undefined ? {} : { antigravityProjectId: frozenGrant.projectId }),
        },
      },
      body: {
        contents: [{ role: 'user', parts: [{ text: request.query }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens: this.options.maxOutputTokens },
      },
      signal,
      config: {
        streaming: {
          'max-line-bytes': this.options.maxResponseBytes,
          'max-frame-bytes': this.options.maxResponseBytes,
        },
      },
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new SubscriptionSearchError(
        `Antigravity subscription search failed with HTTP ${response.status}`,
        'WEB_PROVIDER_UPSTREAM_ERROR',
        response.status,
      )
    }
    const body = await readBoundedText(response, this.options.maxResponseBytes, signal)
    return capResults(parseAntigravitySearch(body, this.options.maxUses), request.maxResults)
  }
}

function capResults(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}
