/**
 * Live subscription model discovery: fetch the model ids a signed-in
 * Claude Code, Codex, or Grok account can currently use, beyond pi-ai's
 * installed catalog for `anthropic`, `openai-codex`, and `xai`.
 *
 * Each provider is interrogated with the exact identity its subscription
 * transport already sends on a chat request ({@link subscriptionHeaders}),
 * pointed at that provider's own model-listing endpoint instead of its
 * inference endpoint. A failure at any stage — network, non-2xx, malformed
 * body — resolves to the last cached list, or an empty list when none is
 * cached yet; the caller merges an empty list into the installed catalog
 * unchanged, so a listing outage never breaks model listing or requests.
 * Nothing here logs the resolved token or the request/response headers that
 * carry it.
 *
 * @module @fi/provider-compat/live-models
 */

import { randomUUID } from 'node:crypto'
import type { PiAiLiveModel, PiAiLiveModelsContext } from '@deepseek-ai/dsh-llm-pi-ai'
import type { SubscriptionProvider } from './headers.ts'
import { subscriptionHeaders } from './headers.ts'
import { providerSettingsFor } from './settings.ts'

/** Response bytes read before a live-listing reply is refused; these are small directories, not model payloads. */
const MAX_RESPONSE_BYTES = 1024 * 1024

/** A representative non-Haiku model id: only its Haiku-ness selects Claude Code's beta list. */
const ANTHROPIC_HEADER_MODEL = 'claude'

/** Codex's own model-listing path takes no model id; any label documents intent in a header dump. */
const CODEX_HEADER_MODEL = 'codex'

/** Grok's model-listing path takes no model id; any label documents intent in a header dump. */
const GROK_HEADER_MODEL = 'grok'

/**
 * One entry of an async, TTL-memoized, stale-while-error cache keyed by
 * caller-supplied key. Mirrors the auth2api reference implementation this
 * package's callers were asked to match: a successful fetch replaces the
 * entry and resets its TTL; a failed one returns the entry already held,
 * however old, rather than an empty answer.
 */
interface CacheEntry<T> {
  readonly value: T
  readonly expires: number
}

/** An async cache as {@link createAsyncCache} returns it. */
export interface AsyncCache<T> {
  /**
   * The cached value for `key`, refreshed through `fetcher` once the TTL has
   * elapsed. `fetcher` receives the currently cached value (`undefined` on a
   * first call) so a conditional request (Codex's ETag) can reuse it, and
   * returns `null` to mean "refresh failed, keep what is cached" rather than
   * replacing a good list with an empty one.
   * @param key - cache key; one per account/provider pair in practice.
   * @param fetcher - the refresh to run once the entry is missing or stale.
   * @returns the fresh or cached value; `undefined` only when no fetch has ever succeeded.
   */
  get(key: string, fetcher: (stale: T | undefined) => Promise<T | null>): Promise<T | undefined>
}

/**
 * Create one TTL-memoized async cache. Concurrent callers for the same stale
 * key share one in-flight refresh rather than issuing one request each.
 * @param ttlMs - how long a successful fetch is served before refreshing again.
 * @returns the cache; callers create one per plugin instance so tests never share state.
 */
export function createAsyncCache<T>(ttlMs: number): AsyncCache<T> {
  const entries = new Map<string, CacheEntry<T>>()
  const inFlight = new Map<string, Promise<T | null>>()
  return {
    async get(key, fetcher) {
      const cached = entries.get(key)
      if (cached !== undefined && cached.expires > Date.now()) return cached.value
      const pending = inFlight.get(key) ?? (async () => {
        try {
          return await fetcher(cached?.value)
        } finally {
          inFlight.delete(key)
        }
      })()
      inFlight.set(key, pending)
      const next = await pending
      if (next === null) return cached?.value
      entries.set(key, { value: next, expires: Date.now() + ttlMs })
      return next
    },
  }
}

/** Combine the caller's cancellation with a fixed upstream timeout. */
function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * Read one JSON reply, refusing a body larger than {@link MAX_RESPONSE_BYTES}.
 * A live-model listing this large cannot be a real directory, so refusing it
 * is safer than parsing an attacker- or bug-inflated payload.
 */
async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error('live model listing exceeded the response size bound')
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new Error('live model listing exceeded the response size bound')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'))
}

/**
 * Anthropic: `GET /v1/models` with the same OAuth identity a Claude Code
 * message request sends, filtered to `claude-*` ids the way the fork's own
 * reference implementation does — the endpoint also lists non-Claude ids that
 * are not selectable through this route.
 * @returns the live `claude-*` ids, or `null` on any failure (kept out of the cache).
 */
async function fetchAnthropicLiveModels(
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<readonly PiAiLiveModel[] | null> {
  try {
    const headers = subscriptionHeaders('anthropic', ANTHROPIC_HEADER_MODEL, randomUUID(), 10_000, {
      Authorization: `Bearer ${apiKey}`,
    })
    const response = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
      method: 'GET',
      headers,
      signal: boundedSignal(signal, 10_000),
    })
    if (!response.ok) return null
    const body = await readBoundedJson(response) as { data?: unknown }
    if (!Array.isArray(body.data)) return null
    const ids = new Set<string>()
    for (const entry of body.data) {
      const id = (entry as { id?: unknown } | null)?.id
      if (typeof id === 'string' && id.startsWith('claude-')) ids.add(id)
    }
    return [...ids].map(id => ({ id }))
  } catch {
    return null
  }
}

/** One entry of Codex's `/codex/models` reply. */
interface CodexModelEntry {
  slug?: unknown
  display_name?: unknown
  visibility?: unknown
}

/** Codex's model catalog plus the ETag it was served with, cached together so a 304 keeps both. */
interface CodexModelCatalog {
  readonly models: readonly PiAiLiveModel[]
  readonly etag: string | null
}

/** One live model entry from a Codex catalog row, or nothing for a hidden or malformed one. */
function codexLiveModel(entry: CodexModelEntry): PiAiLiveModel[] {
  if (typeof entry.slug !== 'string' || entry.slug.length === 0 || entry.visibility === 'hide') return []
  return [{
    id: entry.slug,
    ...typeof entry.display_name === 'string' && entry.display_name.length > 0 ? { name: entry.display_name } : {},
  }]
}

/**
 * Codex: `GET {codexCli.baseUrl}{codexCli.modelsPath}?client_version=…` with
 * the same account headers a Codex message request sends, plus `Accept` and
 * an `If-None-Match` built from the previous successful fetch's ETag — a 304
 * keeps that fetch's model list without re-parsing a body.
 */
async function fetchCodexLiveModels(
  apiKey: string,
  cache: AsyncCache<CodexModelCatalog>,
  signal: AbortSignal | undefined,
): Promise<readonly PiAiLiveModel[]> {
  const settings = providerSettingsFor('codexCli')
  const url = `${settings.baseUrl.replace(/\/+$/, '')}${settings.modelsPath}?client_version=${encodeURIComponent(settings.version)}`
  const result = await cache.get('openai-codex', async (stale) => {
    try {
      const headers: Record<string, string> = {
        ...subscriptionHeaders('openai-codex', CODEX_HEADER_MODEL, randomUUID(), 10_000, {
          Authorization: `Bearer ${apiKey}`,
        }),
        Accept: 'application/json',
        ...stale?.etag == null ? {} : { 'If-None-Match': stale.etag },
      }
      const response = await fetch(url, { method: 'GET', headers, signal: boundedSignal(signal, 10_000) })
      if (response.status === 304) return stale ?? null
      if (!response.ok) return null
      const body = await readBoundedJson(response) as { models?: unknown }
      if (!Array.isArray(body.models)) return null
      return { models: (body.models as CodexModelEntry[]).flatMap(codexLiveModel), etag: response.headers.get('etag') }
    } catch {
      return null
    }
  })
  return result?.models ?? []
}

/** One `data[]` entry of Grok's model-listing reply. */
function grokLiveModel(entry: unknown): PiAiLiveModel[] {
  const id = (entry as { id?: unknown } | null)?.id
  return typeof id === 'string' && id.length > 0 ? [{ id }] : []
}

/**
 * Grok: `GET {grokCode.cliBaseUrl}/models` with the same CLI identity a Grok
 * message request sends.
 * @returns the live model ids, or `null` on any failure (kept out of the cache).
 */
async function fetchGrokLiveModels(
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<readonly PiAiLiveModel[] | null> {
  try {
    const settings = providerSettingsFor('grokCode')
    const headers = subscriptionHeaders('xai', GROK_HEADER_MODEL, randomUUID(), 10_000, {
      Authorization: `Bearer ${apiKey}`,
    })
    const response = await fetch(`${settings.cliBaseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers,
      signal: boundedSignal(signal, 10_000),
    })
    if (!response.ok) return null
    const body = await readBoundedJson(response) as { data?: unknown }
    if (!Array.isArray(body.data)) return null
    return body.data.flatMap(grokLiveModel)
  } catch {
    return null
  }
}

/** The per-plugin-instance caches {@link fetchLiveModels} refreshes through. */
export interface LiveModelCaches {
  readonly anthropic: AsyncCache<readonly PiAiLiveModel[]>
  readonly codex: AsyncCache<CodexModelCatalog>
  readonly grok: AsyncCache<readonly PiAiLiveModel[]>
}

/**
 * Create one instance's live-model caches, all sharing one TTL.
 * @param ttlMs - refresh interval; see {@link Config.liveModelDiscoveryCacheTtlMs}.
 * @returns fresh caches, isolated from any other plugin instance or test.
 */
export function createLiveModelCaches(ttlMs: number): LiveModelCaches {
  return {
    anthropic: createAsyncCache<readonly PiAiLiveModel[]>(ttlMs),
    codex: createAsyncCache<CodexModelCatalog>(ttlMs),
    grok: createAsyncCache<readonly PiAiLiveModel[]>(ttlMs),
  }
}

/**
 * Fetch (through its account's cache) the live model ids/names one
 * subscription route currently advertises. Called only for a route
 * `llm-pi-ai` has already resolved to a stored `OAuth` subscription grant, so
 * this module authenticates with `request.apiKey` and performs no credential
 * or grant lookup of its own.
 * @param request - the resolved route, its OAuth token, and cancellation.
 * @param caches - this plugin instance's per-provider caches.
 * @returns live model ids/names beyond the installed catalog; empty on any failure.
 */
export async function fetchLiveModels(
  request: PiAiLiveModelsContext & { provider: SubscriptionProvider },
  caches: LiveModelCaches,
): Promise<readonly PiAiLiveModel[]> {
  if (request.provider === 'anthropic') {
    const models = await caches.anthropic.get('anthropic', () => fetchAnthropicLiveModels(request.apiKey, request.signal))
    return models ?? []
  }
  if (request.provider === 'openai-codex') return fetchCodexLiveModels(request.apiKey, caches.codex, request.signal)
  const models = await caches.grok.get('xai', () => fetchGrokLiveModels(request.apiKey, request.signal))
  return models ?? []
}
