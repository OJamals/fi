/** Bounded decoders for native provider search responses. */

import { createParser } from 'eventsource-parser'
import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { SubscriptionSearchError } from './types.ts'

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter(value => value !== undefined) : []
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function sourceUrl(value: unknown): string | undefined {
  const candidate = string(value)
  if (candidate === undefined) return undefined
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * Read one response body without retaining bytes beyond the configured limit.
 * @param response - successful provider response whose body will be consumed.
 * @param maxResponseBytes - maximum retained UTF-8 response bytes.
 * @param signal - cancellation signal for body reading.
 * @returns the complete bounded response text.
 */
export async function readBoundedText(
  response: Response,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    await response.body?.cancel().catch(() => {})
    throw new SubscriptionSearchError(
      `subscription search response exceeded ${maxResponseBytes} bytes`,
      'WEB_PROVIDER_RESPONSE_TOO_LARGE',
      response.status,
    )
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  const abort = (): void => { void reader.cancel(signal?.reason).catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const next = await reader.read()
      signal?.throwIfAborted()
      if (next.done) {
        complete = true
        break
      }
      total += next.value.byteLength
      if (total > maxResponseBytes) {
        throw new SubscriptionSearchError(
          `subscription search response exceeded ${maxResponseBytes} bytes`,
          'WEB_PROVIDER_RESPONSE_TOO_LARGE',
          response.status,
        )
      }
      chunks.push(next.value)
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!complete) await reader.cancel(signal?.reason).catch(() => {})
    reader.releaseLock()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(output)
}

function result(
  provider: string,
  content: string | undefined,
  sources: readonly WebSearchSource[],
  searchUses: number,
  maxUses: number,
): WebSearchResult {
  if (searchUses === 0) {
    throw new SubscriptionSearchError(
      `${provider} returned generated text without native search evidence`,
      'WEB_PROVIDER_NO_SEARCH_EVIDENCE',
    )
  }
  if (searchUses > maxUses) {
    throw new SubscriptionSearchError(
      `${provider} returned ${searchUses} native search uses; configured maximum is ${maxUses}`,
      'WEB_PROVIDER_USE_LIMIT_EXCEEDED',
    )
  }
  if (sources.length === 0) {
    throw new SubscriptionSearchError(
      `${provider} returned native search evidence without citation URLs`,
      'WEB_PROVIDER_NO_CITATIONS',
    )
  }
  return { ...(content === undefined ? {} : { content }), sources, truncated: false }
}

function addSource(
  sources: Map<string, WebSearchSource>,
  urlValue: unknown,
  titleValue?: unknown,
  snippetValue?: unknown,
): void {
  const url = sourceUrl(urlValue)
  if (url === undefined) return
  const title = string(titleValue)
  const snippet = string(snippetValue)
  const prior = sources.get(url)
  const resolvedTitle = title ?? prior?.title
  const resolvedSnippet = snippet ?? prior?.snippet
  sources.set(url, {
    url,
    ...(resolvedTitle === undefined ? {} : { title: resolvedTitle }),
    ...(resolvedSnippet === undefined ? {} : { snippet: resolvedSnippet }),
  })
}

function collectResponsesItem(
  itemValue: unknown,
  searchIds: Set<string>,
  sources: Map<string, WebSearchSource>,
  text: string[],
): void {
  const item = record(itemValue)
  if (item === undefined) return
  if (item.type === 'web_search_call' || item.type === 'x_search_call') {
    if (item.status !== 'completed') {
      throw new SubscriptionSearchError(
        `${item.type} ended with status ${String(item.status)}`,
        'WEB_PROVIDER_SEARCH_ERROR',
      )
    }
    searchIds.add(string(item.id) ?? `${item.type}:${searchIds.size}`)
    return
  }
  if (item.type !== 'message') return
  for (const part of records(item.content)) {
    const output = string(part.text)
    if (output !== undefined) text.push(output)
    for (const annotation of records(part.annotations)) {
      if (annotation.type !== 'url_citation') continue
      addSource(sources, annotation.url, annotation.title)
    }
  }
}

/**
 * Decode Responses SSE and retain only native URL citations.
 * @param body - complete bounded SSE text.
 * @param provider - provider name used in safe diagnostics.
 * @param maxUses - maximum accepted native search-action count.
 * @returns normalized answer text and native citation sources.
 */
export function parseResponsesSearch(body: string, provider: 'Codex' | 'Grok', maxUses: number): WebSearchResult {
  const searchIds = new Set<string>()
  const sources = new Map<string, WebSearchSource>()
  const text: string[] = []
  const itemIds = new Set<string>()
  const terminalEvents = new Set<string>()
  const parser = createParser({
    onEvent(event) {
      if (event.data === '[DONE]') return
      let value: JsonRecord
      try {
        value = record(JSON.parse(event.data)) ?? {}
      } catch (error) {
        throw new SubscriptionSearchError(
          `${provider} returned malformed SSE JSON`,
          'WEB_PROVIDER_INVALID_RESPONSE',
          undefined,
          { cause: error },
        )
      }
      if (value.type === 'response.incomplete') {
        throw new SubscriptionSearchError(
          `${provider} returned an incomplete native search response`,
          'WEB_PROVIDER_INCOMPLETE_RESPONSE',
        )
      }
      if (value.type === 'error' || value.type === 'response.failed' || value.error !== undefined) {
        throw new SubscriptionSearchError(
          `${provider} reported a native search failure`,
          'WEB_PROVIDER_SEARCH_ERROR',
        )
      }
      if (value.type === 'response.output_item.done') {
        const item = record(value.item)
        const id = string(item?.id)
        if (id === undefined || !itemIds.has(id)) {
          if (id !== undefined) itemIds.add(id)
          collectResponsesItem(item, searchIds, sources, text)
        }
      }
      if (value.type === 'response.completed') {
        if (record(value.response)?.status !== 'completed') {
          throw new SubscriptionSearchError(
            `${provider} returned a non-completed terminal response`,
            'WEB_PROVIDER_INCOMPLETE_RESPONSE',
          )
        }
        terminalEvents.add('completed')
        for (const item of records(record(value.response)?.output)) {
          const id = string(item.id)
          if (id !== undefined && itemIds.has(id)) continue
          if (id !== undefined) itemIds.add(id)
          collectResponsesItem(item, searchIds, sources, text)
        }
      }
    },
  })
  parser.feed(body)
  if (!terminalEvents.has('completed')) {
    throw new SubscriptionSearchError(
      `${provider} response ended before its completed terminal event`,
      'WEB_PROVIDER_INCOMPLETE_RESPONSE',
    )
  }
  return result(provider, text.join('') || undefined, [...sources.values()], searchIds.size, maxUses)
}

/**
 * Decode one Anthropic Messages response with web-search blocks and citations.
 * @param body - complete bounded Messages JSON text.
 * @param maxUses - maximum accepted native search-action count.
 * @returns normalized answer text and native citation sources.
 */
export function parseClaudeSearch(body: string, maxUses: number): WebSearchResult {
  let response: JsonRecord
  try {
    response = record(JSON.parse(body)) ?? {}
  } catch (error) {
    throw new SubscriptionSearchError(
      'Claude returned malformed JSON',
      'WEB_PROVIDER_INVALID_RESPONSE',
      undefined,
      { cause: error },
    )
  }
  if (response.stop_reason !== 'end_turn') {
    throw new SubscriptionSearchError(
      `Claude returned non-terminal stop reason ${String(response.stop_reason)}`,
      'WEB_PROVIDER_INCOMPLETE_RESPONSE',
    )
  }
  const blocks = records(response.content)
  const searchIds = new Set<string>()
  const titles = new Map<string, string>()
  const text: string[] = []
  const citations: Array<{ url: unknown; citedText: unknown }> = []
  for (const block of blocks) {
    if (block.type === 'server_tool_use' && block.name === 'web_search') {
      searchIds.add(string(block.id) ?? `search:${searchIds.size}`)
      continue
    }
    if (block.type === 'web_search_tool_result') {
      if (block.is_error === true || block.error_code !== undefined) {
        throw new SubscriptionSearchError('Claude reported a native search failure', 'WEB_PROVIDER_SEARCH_ERROR')
      }
      for (const searchResult of records(block.content)) {
        if (searchResult.type !== 'web_search_result') continue
        const url = sourceUrl(searchResult.url)
        const title = string(searchResult.title)
        if (url !== undefined && title !== undefined) titles.set(url, title)
      }
      continue
    }
    if (block.type !== 'text') continue
    const output = string(block.text)
    if (output !== undefined) text.push(output)
    for (const citation of records(block.citations)) {
      if (citation.type !== 'web_search_result_location') continue
      citations.push({ url: citation.url, citedText: citation.cited_text })
    }
  }
  const sources = new Map<string, WebSearchSource>()
  for (const citation of citations) {
    const url = sourceUrl(citation.url)
    addSource(sources, url, url === undefined ? undefined : titles.get(url), citation.citedText)
  }
  const usageCount = record(record(response.usage)?.server_tool_use)?.web_search_requests
  const searchUses = typeof usageCount === 'number' && Number.isSafeInteger(usageCount)
    ? Math.max(usageCount, searchIds.size)
    : searchIds.size
  return result('Claude', text.join('') || undefined, [...sources.values()], searchUses, maxUses)
}

/**
 * Decode native Gemini grounding metadata returned by Antigravity.
 * @param body - complete bounded native Gemini JSON text.
 * @param maxUses - maximum accepted grounding-query count.
 * @returns normalized answer text and native grounding sources.
 */
export function parseAntigravitySearch(body: string, maxUses: number): WebSearchResult {
  let response: JsonRecord
  try {
    response = record(JSON.parse(body)) ?? {}
  } catch (error) {
    throw new SubscriptionSearchError(
      'Antigravity returned malformed JSON',
      'WEB_PROVIDER_INVALID_RESPONSE',
      undefined,
      { cause: error },
    )
  }
  const candidate = records(response.candidates)[0]
  if (candidate?.finishReason !== 'STOP') {
    throw new SubscriptionSearchError(
      `Antigravity returned non-terminal finish reason ${String(candidate?.finishReason)}`,
      'WEB_PROVIDER_INCOMPLETE_RESPONSE',
    )
  }
  const grounding = record(candidate.groundingMetadata)
  const text = records(record(candidate.content)?.parts).map(part => string(part.text) ?? '').join('')
  const chunks = records(grounding?.groundingChunks)
  const snippets = new Map<number, string>()
  for (const support of records(grounding?.groundingSupports)) {
    const snippet = string(record(support.segment)?.text)
    if (snippet === undefined || !Array.isArray(support.groundingChunkIndices)) continue
    for (const index of support.groundingChunkIndices) {
      if (typeof index === 'number' && Number.isSafeInteger(index) && !snippets.has(index)) snippets.set(index, snippet)
    }
  }
  const sources = new Map<string, WebSearchSource>()
  chunks.forEach((chunk, index) => {
    const web = record(chunk.web)
    addSource(sources, web?.uri, web?.title, snippets.get(index))
  })
  const queries = Array.isArray(grounding?.webSearchQueries)
    ? grounding.webSearchQueries.filter(query => typeof query === 'string')
    : []
  return result('Antigravity', text || undefined, [...sources.values()], queries.length, maxUses)
}
