/** Native search decoders require completed search evidence and usable citations. */
import { describe, expect, it, vi } from 'vitest'
import { parseAntigravitySearch, parseClaudeSearch, parseResponsesSearch, readBoundedText } from '../src/response.ts'

const url = 'https://example.com/source'
const sse = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
const search = { type: 'web_search_call', status: 'completed' }
const message = { type: 'message', content: [{ text: '', annotations: [{ type: 'url_citation', url }] }] }
const completed = (output: unknown[]) => ({ type: 'response.completed', response: { status: 'completed', output } })

describe('bounded bodies', () => {
  it('handles empty bodies and declared size limits without acquiring a reader', async () => {
    await expect(readBoundedText(new Response(null), 1)).resolves.toBe('')
    await expect(readBoundedText(new Response(null, { headers: { 'content-length': '2' } }), 1))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_RESPONSE_TOO_LARGE' })
    const cancel = vi.fn(() => { throw new Error('cancel failed') })
    const body = new ReadableStream({ cancel })
    await expect(readBoundedText(new Response(body, { headers: { 'content-length': '2' } }), 1))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_RESPONSE_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('releases the reader when a streamed size limit and cancellation both fail', async () => {
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])) },
      cancel() { throw new Error('cancel failed') },
    })
    await expect(readBoundedText(new Response(body), 1)).rejects.toMatchObject({ code: 'WEB_PROVIDER_RESPONSE_TOO_LARGE' })
    expect(body.locked).toBe(false)
  })

  it('cancels a pending body read and releases its lock despite cancellation failure', async () => {
    const pending = Promise.withResolvers<undefined>()
    const cancel = vi.fn(() => { throw new Error('cancel failed') })
    const body = new ReadableStream({ pull() { pending.resolve(undefined) }, cancel })
    const controller = new AbortController()
    const reading = readBoundedText(new Response(body), 10, controller.signal)
    const rejected = expect(reading).rejects.toThrow('cancelled')
    await pending.promise
    controller.abort(new Error('cancelled'))
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })
})

describe('Responses search', () => {
  it('deduplicates completed items and retains citation-only responses', () => {
    const item = { ...search, id: 's1' }
    const body = sse(null, { type: 'response.output_item.done', item }, { type: 'response.output_item.done', item },
      { type: 'response.output_item.done', item: null }, { type: 'response.output_item.done', item: { type: 'unknown' } },
      completed([item, { ...search, id: 's2', type: 'x_search_call' }, search, message])) + 'data: [DONE]\n\n'
    expect(parseResponsesSearch(body, 'Grok', 3)).toEqual({ sources: [{ url }], truncated: false })
  })

  it('ignores unusable citations while preserving prior metadata for a repeated URL', () => {
    const annotations = [
      { type: 'other', url },
      ...[null, '', 'broken', 'file:///secret'].map(value => ({ type: 'url_citation', url: value })),
      { type: 'url_citation', url, title: 'Title' }, { type: 'url_citation', url },
    ]
    const body = sse(completed([search, { type: 'message', content: [null, { text: 'Answer', annotations }] }]))
    expect(parseResponsesSearch(body, 'Codex', 1)).toEqual({ content: 'Answer', sources: [{ url, title: 'Title' }], truncated: false })
  })

  it.each(['error', 'response.failed', 'error-field', 'response.incomplete', 'bad-terminal', 'failed-search'])
  ('rejects %s', (type) => {
    const event = type === 'error-field' ? { error: {} }
      : type === 'bad-terminal' ? { type: 'response.completed', response: { status: 'failed' } }
        : type === 'failed-search' ? completed([{ ...search, status: 'failed' }]) : { type }
    expect(() => parseResponsesSearch(sse(event), 'Codex', 1)).toThrow()
  })

  it('rejects malformed SSE JSON', () => {
    expect(() => parseResponsesSearch('data: {broken\n\n', 'Grok', 1)).toThrow('malformed SSE JSON')
  })
})

describe('Claude search', () => {
  it.each(['{broken', 'null', '[]'])('rejects malformed or non-terminal response %s', (body) => {
    expect(() => parseClaudeSearch(body, 1)).toThrow()
  })

  it.each([{ is_error: true }, { error_code: 'unavailable' }])('rejects native search failure %j', (error) => {
    expect(() => parseClaudeSearch(JSON.stringify({ stop_reason: 'end_turn', content: [
      { type: 'web_search_tool_result', ...error },
    ] }), 1)).toThrow('native search failure')
  })

  it('accepts citation-only content, ignores unrelated blocks, and filters unsupported citation URLs', () => {
    const body = JSON.stringify({ stop_reason: 'end_turn', content: [
      null, { type: 'unknown' }, { type: 'server_tool_use', name: 'other' }, { type: 'server_tool_use', name: 'web_search' },
      { type: 'web_search_tool_result', content: [null, { type: 'other' },
        { type: 'web_search_result', url: 'bad', title: 'Bad' }, { type: 'web_search_result', url },
      ] },
      { type: 'text', citations: [{ type: 'other' }, { type: 'web_search_result_location', url: 'bad' },
        { type: 'web_search_result_location', url, cited_text: 'snippet' }, { type: 'web_search_result_location', url }] },
    ] })
    expect(parseClaudeSearch(body, 1)).toEqual({ sources: [{ url, snippet: 'snippet' }], truncated: false })
  })
})

describe('Antigravity search', () => {
  it.each(['{broken', 'null', '[]'])('rejects malformed or non-terminal response %s', (body) => {
    expect(() => parseAntigravitySearch(body, 1)).toThrow()
  })

  it('accepts grounding without answer text and keeps the first valid supporting snippet', () => {
    const body = JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{}, { text: '' }] },
      groundingMetadata: { webSearchQueries: ['query', null], groundingChunks: [{ web: { uri: url } }, {}],
        groundingSupports: [{}, { segment: { text: 'ignored' } },
          { segment: { text: 'first' }, groundingChunkIndices: [0, '0', 0.5] },
          { segment: { text: 'later' }, groundingChunkIndices: [0] }],
      } }] })
    expect(parseAntigravitySearch(body, 1)).toEqual({ sources: [{ url, snippet: 'first' }], truncated: false })
  })

  it('rejects ungrounded content when query metadata is absent', () => {
    expect(() => parseAntigravitySearch(JSON.stringify({ candidates: [{ finishReason: 'STOP' }] }), 1))
      .toThrow('without native search evidence')
  })
})
