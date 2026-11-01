/** The public Gemini chat transport shares the Gemini codec but sends the bare request to a caller-named endpoint. */
import { afterEach, expect, it, vi } from 'vitest'
import { callGeminiChat } from '../src/transport.ts'
import type { GeminiChatTarget } from '../src/transport.ts'

const target: GeminiChatTarget = {
  baseUrl: 'https://opencode.ai/zen/v1', model: 'gemini-3-pro', apiKey: 'key', headers: { 'x-client': 'cli', 'user-agent': 'native/2.2.5' },
}
const messages = [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'ping' }]
const events = (...values: unknown[]) => values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')
const bare = events(
  { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }, { text: 'PO' }] } }] },
  {
    candidates: [{ content: { role: 'model', parts: [{ text: 'NG' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
  },
)
const wrapped = events({ response: { candidates: [{ content: { parts: [{ text: 'PONG' }] }, finishReason: 'STOP' }] } })
interface ChatChunk {
  id: string
  model: string
  usage?: unknown
  choices: { delta: { content?: string; reasoning_content?: string }; finish_reason: string | null }[]
}
const sse = (text = bare, headers: HeadersInit = { 'content-type': 'text/event-stream' }) => new Response(text, { headers })

afterEach(() => { vi.unstubAllGlobals() })

it('sends the bare Gemini request with the key and the caller identity', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => sse())
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  const tools = [{ type: 'function', function: { name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: { key: { type: 'string' } } } } }]
  await callGeminiChat({ model: 'wire', messages, tools, tool_choice: 'required', temperature: 0.2, top_p: 0.9, max_completion_tokens: 50 }, target, signal)
  const [url, init] = fetcher.mock.calls[0] ?? []
  expect(url).toBe('https://opencode.ai/zen/v1/models/gemini-3-pro:streamGenerateContent?alt=sse')
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal })
  expect(init?.headers).toEqual({
    'x-client': 'cli', 'user-agent': 'native/2.2.5', accept: 'text/event-stream', 'x-goog-api-key': 'key', 'content-type': 'application/json',
  })
  const wire = JSON.parse(init?.body as string) as Record<string, unknown>
  expect(wire).toEqual({
    contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    systemInstruction: { parts: [{ text: 'Be brief' }] },
    tools: [{ functionDeclarations: [expect.objectContaining({ name: 'lookup' })] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 50 },
  })
})

it.each([
  ['a trailing slash', 'https://opencode.ai/zen/v1/', 'gemini-3-pro', 'https://opencode.ai/zen/v1/models/gemini-3-pro:streamGenerateContent?alt=sse'],
  ['a model needing escapes', 'https://opencode.ai/zen/v1', 'google/gemini 3', 'https://opencode.ai/zen/v1/models/google%2Fgemini%203:streamGenerateContent?alt=sse'],
])('builds the model path for %s', async (_name, baseUrl, model, expected) => {
  const fetcher = vi.fn<typeof fetch>(async () => sse())
  vi.stubGlobal('fetch', fetcher)
  await callGeminiChat({ model: 'wire', messages }, { baseUrl, model, apiKey: 'key' })
  const [url, init] = fetcher.mock.calls[0] ?? []
  expect(url).toBe(expected)
  expect(init?.headers).toEqual({ accept: 'text/event-stream', 'x-goog-api-key': 'key', 'content-type': 'application/json' })
})

it('lets the caller replace thinking and fill generation fields without overriding translated ones', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => sse())
  vi.stubGlobal('fetch', fetcher)
  const configOf = async (extra: Partial<GeminiChatTarget>) => {
    await callGeminiChat({ model: 'gemini-3-pro', messages, temperature: 0.2 }, { ...target, ...extra })
    return (JSON.parse(fetcher.mock.calls.at(-1)?.[1]?.body as string) as { generationConfig: Record<string, unknown> }).generationConfig
  }
  expect(await configOf({})).toEqual({ temperature: 0.2, thinkingConfig: { includeThoughts: true } })
  expect(await configOf({ thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } }))
    .toEqual({ temperature: 0.2, thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } })
  expect(await configOf({ thinkingConfig: { includeThoughts: false, thinkingBudget: 0 }, generation: { topK: 20, temperature: 1 } }))
    .toEqual({ topK: 20, temperature: 0.2, thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } })
})

it('streams unwrapped and wrapped Gemini events as chat chunks', async () => {
  for (const [events, text] of [[bare, 'PONG'], [wrapped, 'PONG']] as const) {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => sse(events)))
    const response = await callGeminiChat({ model: 'wire', messages, stream: true }, target)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const body = await response.text()
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true)
    const chunks = body.split('\n\n').filter(frame => frame.startsWith('data: {')).map(frame => JSON.parse(frame.slice(6)) as ChatChunk)
    expect(chunks.map(chunk => chunk.choices[0]?.delta.content ?? '').join('')).toBe(text)
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop')
    expect(chunks[0]?.model).toBe('wire')
    expect(chunks[0]?.id).toMatch(/^chatcmpl-gemini-/)
    if (events === bare) {
      expect(chunks.map(chunk => chunk.choices[0]?.delta.reasoning_content ?? '').join('')).toBe('thinking')
      expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })
    }
  }
})

it('aggregates unwrapped and wrapped Gemini events into one chat completion', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => sse()))
  await expect((await callGeminiChat({ model: 'wire', messages }, target)).json()).resolves.toMatchObject({
    choices: [{ message: { content: 'PONG', reasoning_content: 'thinking' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => sse(wrapped)))
  await expect((await callGeminiChat({ model: 'wire', messages }, target)).json()).resolves.toMatchObject({
    choices: [{ message: { content: 'PONG' }, finish_reason: 'stop' }],
  })
})

it('returns a failed upstream reply unchanged for the caller to classify', async () => {
  const upstream = Response.json({ error: { type: 'server_error', message: 'Upstream request failed: Insufficient account funds' } }, { status: 402, headers: { 'retry-after': '7' } })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => upstream))
  const response = await callGeminiChat({ model: 'wire', messages }, target)
  expect(response).toBe(upstream)
  expect(response.status).toBe(402)
  expect(response.headers.get('retry-after')).toBe('7')
  await expect(response.json()).resolves.toMatchObject({ error: { message: 'Upstream request failed: Insufficient account funds' } })
})

it.each([
  ['a reply that is not an event stream', () => new Response('{}', { headers: { 'content-type': 'application/json' } })],
  ['a reply with no body', () => new Response(null, { headers: { 'content-type': 'text/event-stream' } })],
])('refuses %s and releases its body', async (_name, reply) => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => reply()))
  await expect(callGeminiChat({ model: 'wire', messages }, target)).rejects.toThrow('Gemini returned no SSE stream')
})

it('refuses a request over the byte limit before any fetch', async () => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  await expect(callGeminiChat({ model: 'wire', messages: [{ role: 'user', content: 'x'.repeat(20 * 1024 * 1024) }] }, target))
    .rejects.toThrow('Gemini request exceeds byte limit')
  expect(fetcher).not.toHaveBeenCalled()
})

it.each([
  'http://opencode.ai/zen/v1', 'https://user:pass@opencode.ai/zen/v1', 'https://opencode.ai/zen/v1?key=1', 'https://opencode.ai/zen/v1#frag',
])('refuses the endpoint %s before any fetch', async (baseUrl) => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  await expect(callGeminiChat({ model: 'wire', messages }, { ...target, baseUrl })).rejects.toThrow('Invalid Gemini endpoint')
  expect(fetcher).not.toHaveBeenCalled()
})
