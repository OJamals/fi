/** The Code Assist chat transport shares the Gemini codec but names its own endpoint, identity, and failures. */
import { afterEach, expect, it, vi } from 'vitest'
import { callCodeAssistChat } from '../src/transport.ts'

const ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'
const messages = [{ role: 'user', content: 'ping' }]
const sse = (headers: HeadersInit = { 'content-type': 'text/event-stream' }) => new Response(
  `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'PONG' }] }, finishReason: 'STOP' }] } })}\n\n`,
  { headers },
)

afterEach(() => { vi.unstubAllGlobals() })

it.each([
  ['a model outside the Gemini family', 'claude-sonnet-4-6', 'project'],
  ['a model with illegal characters', 'gemini-3 pro', 'project'],
  ['an empty project', 'gemini-3-flash', ''],
])('refuses %s before any fetch', async (_name, model, project) => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  await expect(callCodeAssistChat({ model, messages }, 'token', project)).rejects.toThrow('Invalid Code Assist model or project')
  expect(fetcher).not.toHaveBeenCalled()
})

it('refuses a request over the byte limit before any fetch', async () => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  const input = { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'x'.repeat(20 * 1024 * 1024) }] }
  await expect(callCodeAssistChat(input, 'token', 'project')).rejects.toThrow('exceeds byte limit')
  expect(fetcher).not.toHaveBeenCalled()
})

it('sends the project envelope with its own identity and no Antigravity request identity', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => sse())
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  const response = await callCodeAssistChat({ model: 'gemini-3-flash', messages }, 'token', 'project', signal)
  const [url, init] = fetcher.mock.calls[0] ?? []
  expect(url).toBe(ENDPOINT)
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal })
  expect(init?.headers).toMatchObject({ authorization: 'Bearer token', 'user-agent': 'fi-code-assist/0.2.0' })
  const wire = JSON.parse(init?.body as string) as Record<string, unknown>
  expect(wire).toMatchObject({ model: 'gemini-3-flash', project: 'project' })
  expect(wire).not.toHaveProperty('userAgent')
  await expect(response.json()).resolves.toMatchObject({
    choices: [{ message: { content: 'PONG' }, finish_reason: 'stop' }],
  })
})

it('streams chat chunks when asked to', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => sse()))
  const response = await callCodeAssistChat({ model: 'gemini-3-flash', messages, stream: true }, 'token', 'project')
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const text = await response.text()
  expect(text).toContain('"content":"PONG"')
  expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
})

it('reports an upstream failure by status alone and releases the body', async () => {
  const cancel = vi.fn()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), { status: 403 })))
  const response = await callCodeAssistChat({ model: 'gemini-3-flash', messages }, 'token', 'project')
  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toEqual({ error: { message: 'Code Assist upstream answered 403', type: 'upstream_error' } })
  expect(cancel).toHaveBeenCalledOnce()
})

it.each([
  ['a reply that is not an event stream', () => new Response('{}', { headers: { 'content-type': 'application/json' } })],
  ['a reply with no body', () => new Response(null, { headers: { 'content-type': 'text/event-stream' } })],
])('refuses %s', async (_name, reply) => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => reply()))
  await expect(callCodeAssistChat({ model: 'gemini-3-flash', messages }, 'token', 'project'))
    .rejects.toThrow('Code Assist returned no SSE stream')
})
