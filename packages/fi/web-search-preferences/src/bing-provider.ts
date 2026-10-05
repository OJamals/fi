/** Keyless Bing web-search results through its RSS endpoint. */

import { XMLParser } from 'fast-xml-parser'
import { SyntaxValidator } from 'fast-xml-validator'
import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from '@deepseek-ai/dsh-web'

/** Bing web-search endpoint base. */
export const BING_DEFAULT_BASE_URL = 'https://www.bing.com'
/** Default maximum RSS response bytes retained before parsing. */
export const BING_DEFAULT_MAX_RESPONSE_BYTES = 1_048_576

/** Credential-free search with bounded RSS reads; HTTP and malformed-feed failures stay visible. */
export class BingRssSearchProvider implements WebSearchProvider {
  readonly id = 'bing-rss'

  /**
   * @param baseURL - validated HTTPS Bing endpoint base.
   * @param maxResponseBytes - validated positive response byte limit.
   */
  constructor(private readonly baseURL: string, private readonly maxResponseBytes: number) {}

  /** @returns true; this provider needs no account or credential. */
  available(): boolean { return true }

  /**
   * Search once without credential reads or account fallback.
   * @param request - query and optional result limit.
   * @param signal - caller cancellation, including the router's lifecycle.
   * @returns titles, destination URLs, and snippets from the RSS feed.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const endpoint = new URL(`${this.baseURL.replace(/\/+$/, '')}/search`)
    endpoint.searchParams.set('q', request.query)
    endpoint.searchParams.set('format', 'rss')
    try {
      signal?.throwIfAborted()
      const response = await fetch(endpoint, {
        headers: { accept: 'application/rss+xml, application/xml, text/xml' },
        redirect: 'error',
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new WebError(`Bing RSS search failed with HTTP ${response.status}`, 'WEB_PROVIDER_ERROR')
      }
      const xml = await readRss(response, this.maxResponseBytes, signal)
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
        throw new WebError('Bing search returned invalid RSS', 'WEB_PROVIDER_ERROR')
      }
      SyntaxValidator.validate(xml)
      const parsed: unknown = new XMLParser({
        parseTagValue: false,
        isArray: (_name, path) => path === 'rss.channel.item',
      }).parse(xml)
      const channel = record(record(record(parsed).rss).channel)
      const items: unknown = channel.item ?? []
      if (!Array.isArray(items)) throw new TypeError('RSS items must be an array')
      const sources = items.map((value: unknown) => {
        const item = record(value)
        const url = text(item.link)
        if (!URL.canParse(url) || !['http:', 'https:'].includes(new URL(url).protocol)) {
          throw new TypeError('RSS result URL must use HTTP or HTTPS')
        }
        const title = item.title === undefined ? undefined : text(item.title)
        const snippet = item.description === undefined ? undefined : text(item.description)
        return { url, ...title === undefined ? {} : { title }, ...snippet === undefined ? {} : { snippet } }
      })
      const limit = request.maxResults ?? sources.length
      return { sources: sources.slice(0, limit), truncated: sources.length > limit }
    } catch (error: unknown) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw new WebError('Bing RSS search aborted', 'WEB_ABORTED', { cause: error })
      }
      if (error instanceof WebError) throw error
      throw new WebError(`Bing RSS search failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

async function readRss(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const tooLarge = (): WebError => new WebError(`Bing RSS response exceeded ${maxBytes} bytes`, 'WEB_PROVIDER_RESPONSE_TOO_LARGE')
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw tooLarge()
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder()
  let bytes = 0
  let output = ''
  let complete = false
  const cancel = async (): Promise<void> => {
    try { await reader.cancel(signal?.reason) }
    catch (error) {
      // Cleanup failure must not replace the aborted or oversized response error.
      void error
    }
  }
  const abort = (): void => { void cancel() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      signal?.throwIfAborted()
      if (chunk.done) { complete = true; break }
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw tooLarge()
      output += decoder.decode(chunk.value, { stream: true })
    }
    return output + decoder.decode()
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!complete) await cancel()
    reader.releaseLock()
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('RSS element must be an object')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('RSS result field must be text')
  return value
}
