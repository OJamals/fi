/** Native MCP search requests over the vendor's OAuth-protected resource. */
import type { Context } from '@deepseek-ai/cordis'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { WebError, type WebSearchProvider, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'
import { resolveSearchToken, searchFetch, searchOAuthProviders, type SearchOAuthId, type SearchOAuthLimits } from './search-oauth.ts'

/**
 * Normalize vendor JSON or labelled text without treating URLs inside snippets as citations.
 * @param text - original text blocks returned by the vendor search tool.
 * @param structured - optional MCP structured result.
 * @param maxResults - caller's source cap.
 * @returns original answer text and the vendor's explicit result URLs.
 */
export function normalizeSearchResult(text: string, structured: unknown, maxResults?: number): WebSearchResult {
  const sources: WebSearchSource[] = []
  const add = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    if ('url' in value && typeof value.url === 'string' && URL.canParse(value.url)
      && ['https:', 'http:'].includes(new URL(value.url).protocol)) {
      if (!sources.some(source => source.url === value.url)) sources.push({
        url: value.url,
        ...('title' in value && typeof value.title === 'string' ? { title: value.title } : {}),
        ...('content' in value && typeof value.content === 'string' ? { snippet: value.content } : {}),
      })
    }
  }
  const json = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(add); return }
    if (typeof value !== 'object' || value === null) return
    if ('results' in value) json(value.results)
    if ('search_results' in value) json(value.search_results)
    if ('web' in value) json(value.web)
    if ('data' in value) json(value.data)
  }
  json(structured)
  try { json(JSON.parse(text)) } catch (_error) { /* Vendor text results need no JSON conversion. */ }
  for (const block of text.split(/\n\s*(?:---\s*)?\n/)) {
    const url = /^URL:\s*(https?:\/\/\S+)\s*$/m.exec(block)?.[1]
    const title = /^Title:\s*(.+)$/m.exec(block)?.[1]
    if (url !== undefined) add({ url, ...(title === undefined ? {} : { title }) })
  }
  return { content: text, sources: sources.slice(0, maxResults), truncated: maxResults !== undefined && sources.length > maxResults }
}

/**
 * Build an operation-scoped OAuth search adapter using the maintained MCP client.
 * @param ctx - credential service owner.
 * @param id - selected vendor OAuth route.
 * @param limits - request and byte bounds.
 * @returns search adapter; each call closes its connection on every outcome.
 */
export function createOAuthSearchProvider(ctx: Context, id: SearchOAuthId, limits: SearchOAuthLimits): WebSearchProvider {
  return {
    id,
    available: () => true,
    async search(request, callerSignal) {
      const signal = callerSignal ?? new AbortController().signal
      const token = await resolveSearchToken(ctx, id, limits, signal)
      const vendor = searchOAuthProviders[id]
      const client = new Client({ name: 'fi-search', version: '0.2.0' })
      const transport = new StreamableHTTPClientTransport(new URL(vendor.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: searchFetch(signal, limits),
      })
      try {
        await client.connect(transport, { signal, timeout: limits.requestTimeoutMs })
        const count = request.maxResults
        const args = id === 'parallel-oauth' ? { objective: request.query, search_queries: [request.query] }
          : id === 'exa-oauth' ? { query: request.query, objective: request.query, ...(count === undefined ? {} : { numResults: count }) }
            : id === 'firecrawl-oauth' ? {
              query: request.query, objective: request.query, ...(count === undefined ? {} : { limit: Math.min(100, count) }),
            }
              : {
                query: request.query, objective: request.query,
                ...(count === undefined ? {} : { max_results: Math.max(5, Math.min(20, count)) }),
              }
        const result = await client.callTool({ name: vendor.tool, arguments: args }, { signal, timeout: limits.requestTimeoutMs })
        if (result.isError) throw new WebError(`${vendor.label} search failed`, 'WEB_PROVIDER_ERROR')
        const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n\n')
        return normalizeSearchResult(text, result.structuredContent, count)
      } finally {
        await client.close()
        await transport.close()
      }
    },
  }
}
