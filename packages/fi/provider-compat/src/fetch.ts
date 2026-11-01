/** Request-scoped subscription fetch wrappers. */

import { randomUUID } from 'node:crypto'
import type { PiAiRequestTransportContext } from '@deepseek-ai/dsh-llm-pi-ai'
import { normalizeGrokError } from './grok-error.ts'
import {
  conversationHeaders,
  HARNESS_ATTRIBUTION_HEADER,
  subscriptionHeaders,
  type SubscriptionProvider,
} from './headers.ts'
import { providerSettingsFor } from './settings.ts'

type FetchFunction = typeof globalThis.fetch

function inputUrl(input: Parameters<FetchFunction>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function mergedHeaders(input: Parameters<FetchFunction>[0], init: RequestInit | undefined): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, name) => { headers.set(name, value) })
  return headers
}

function replaceInput(input: Parameters<FetchFunction>[0], url: string): Parameters<FetchFunction>[0] {
  if (typeof input === 'string') return url
  if (input instanceof URL) return new URL(url)
  return new Request(url, input)
}

function endpoints(provider: SubscriptionProvider): { source: string; target: string } {
  if (provider === 'openai-codex') {
    const settings = providerSettingsFor('codexCli')
    const endpoint = `${settings.baseUrl.replace(/\/$/, '')}/${settings.responsesPath.replace(/^\//, '')}`
    return { source: endpoint, target: endpoint }
  }
  if (provider === 'anthropic') {
    const endpoint = 'https://api.anthropic.com/v1/messages'
    return { source: endpoint, target: endpoint }
  }
  const settings = providerSettingsFor('grokCode')
  return {
    source: `${settings.apiBaseUrl.replace(/\/$/, '')}/responses`,
    target: `${settings.cliBaseUrl.replace(/\/$/, '')}/responses`,
  }
}

/**
 * Return the canonical subscription endpoint used by a direct provider request.
 * @param provider - supported subscription provider id.
 * @returns the provider's request endpoint; Grok resolves to its CLI endpoint.
 */
export function subscriptionEndpoint(provider: SubscriptionProvider): string {
  return endpoints(provider).target
}

function matchesSource(provider: SubscriptionProvider, candidate: string, source: string): boolean {
  if (provider !== 'anthropic') return candidate === source
  const url = new URL(candidate)
  const expected = new URL(source)
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash !== '') return false
  return [...url.searchParams].every(([name, value]) => name === 'beta' && value === 'true')
}

/**
 * Wrap one provider request with capture-derived subscription headers.
 *
 * Only the exact inference endpoint is modified. Anthropic also accepts its
 * SDK's `beta=true` query while preserving it byte-for-byte. Other requests
 * delegate with their original input and init. Grok's exact public Responses
 * URL is replaced by the canonical CLI endpoint, its conversation headers are
 * added, and its failures are normalized; Codex and Anthropic retain their URL.
 * Codex gains `thread-id` beside the `session-id` pi-ai sent.
 * @param request - non-secret request facts captured by llm-pi-ai.
 * @param delegate - underlying fetch implementation.
 * @returns a request-scoped fetch implementation.
 */
export function subscriptionFetch(
  request: PiAiRequestTransportContext & { provider: SubscriptionProvider },
  delegate: FetchFunction = globalThis.fetch,
): FetchFunction {
  const endpoint = endpoints(request.provider)
  return async (input, init) => {
    const url = inputUrl(input)
    if (!matchesSource(request.provider, url, endpoint.source)) return delegate(input, init)
    const headers = mergedHeaders(input, init)
    headers.set(HARNESS_ATTRIBUTION_HEADER, request.harnessUserAgent)
    const sessionId = request.sessionId ?? randomUUID()
    const merged = conversationHeaders(request.provider, subscriptionHeaders(
      request.provider,
      request.model,
      sessionId,
      request.timeoutMs,
      Object.fromEntries(headers.entries()),
    ), sessionId)
    const target = request.provider === 'xai' ? endpoint.target : url
    const response = await delegate(replaceInput(input, target), { ...init, headers: merged, redirect: 'error' })
    return request.provider === 'xai' ? normalizeGrokError(response) : response
  }
}
