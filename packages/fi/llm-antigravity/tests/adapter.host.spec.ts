/**
 * The Antigravity adapter: catalog fallback, grant resolution behavior, and
 * the SSE→StreamChunk projection, all against a scripted `fetch` so no
 * Google endpoint is ever touched.
 *
 * The mock speaks the UPSTREAM shape (Gemini `candidates`/`parts` events
 * wrapped in the Cloud Code envelope's `response` field), because the
 * adapter consumes the transport's output — exercising the full envelope →
 * OpenAI chunk → fi chunk pipeline, not a shortcut around it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'

import { AntigravityAdapter } from '../src/adapter.ts'
import type { AntigravityGrant } from '../src/adapter.ts'
import { ANTIGRAVITY_STATIC_CATALOG, antigravityModelName } from '../src/catalog.ts'
import { __resetAntigravityModelsCache } from '../src/transport.ts'

const GRANT: AntigravityGrant = { accessToken: 'ya29.test', projectId: 'project-1' }

/** A grant resolver that always answers the same way. */
const grants = (grant: AntigravityGrant | undefined) => () => Promise.resolve(grant)

/** One user message carrying plain text. */
function userMessage(text: string): Message {
  return { id: `m-${text}` as never, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** The smallest legal request. */
function request(overrides?: Partial<GenerateOptions>): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'claude-sonnet-4-6',
    messages: [userMessage('Hi')],
    ...overrides,
  } as GenerateOptions
}

/** A 200 Response whose body is the given SSE data payloads. */
function sseResponse(payloads: readonly string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' }, ...init })
}

/** One Gemini-envelope event carrying text parts. */
function geminiText(text: string, finishReason?: string, usage = false): string {
  return JSON.stringify({
    response: {
      candidates: [{ content: { parts: [{ text }], role: 'model' }, ...finishReason === undefined ? {} : { finishReason } }],
      ...usage
        ? { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 } }
        : {},
    },
  })
}

/** Drain a chunk stream into an array. */
async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

afterEach(() => {
  vi.unstubAllGlobals()
  __resetAntigravityModelsCache()
})

describe('catalog', () => {
  it('ships the static Antigravity text models', () => {
    const ids = ANTIGRAVITY_STATIC_CATALOG.map(entry => entry.id)
    expect(ids).toContain('antigravity-claude-sonnet-4-6')
    expect(ids).toContain('antigravity-gemini-3.1-pro-high')
    expect(ids).toContain('claude-opus-4-6-thinking')
  })

  it('derives display names and keeps unknown ids truthful', () => {
    expect(antigravityModelName('antigravity-claude-sonnet-4-6')).toBe('Claude Sonnet 4.6')
    expect(antigravityModelName('gemini-3.1-pro-high')).toBe('Gemini 3.1 Pro High')
    expect(antigravityModelName('something-unseen')).toBe('something-unseen')
  })
})

describe('listModels', () => {
  it('answers the static catalog when no grant is stored', async () => {
    const adapter = new AntigravityAdapter(grants(undefined))
    const models = await adapter.listModels('antigravity')
    expect(models.length).toBe(ANTIGRAVITY_STATIC_CATALOG.length)
    expect(models[0]).toMatchObject({ provider: 'antigravity', inputModalities: ['text'] })
  })

  it('prefers the live projected catalog when a grant reaches it', async () => {
    // selectableTextModelIds only projects ids the reply ADVERTISES through
    // the agent sorts, so the mock names them there.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      models: { 'gemini-pro-agent': {}, 'claude-sonnet-4-6': {} },
      agentModelSorts: [{ groups: [{ modelIds: ['gemini-pro-agent', 'claude-sonnet-4-6'] }] }],
      imageGenerationModelIds: [],
    })))
    const adapter = new AntigravityAdapter(grants(GRANT))
    const models = await adapter.listModels('antigravity')
    const ids = models.map(model => model.id)
    expect(ids).toContain('gemini-3.1-pro-high')
    expect(ids).toContain('claude-sonnet-4-6')
  })

  it('degrades to the static catalog when the live fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const adapter = new AntigravityAdapter(grants(GRANT))
    const models = await adapter.listModels('antigravity')
    expect(models.length).toBe(ANTIGRAVITY_STATIC_CATALOG.length)
    expect(models.every(model => !model.id.includes('image'))).toBe(true)
  })
})

describe('stream', () => {
  it('finishes with no-grant when signed out, without touching the network', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = new AntigravityAdapter(grants(undefined))
    const chunks = await collect(adapter.stream(request()))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'fi-antigravity/no-grant' } } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('finishes with no-project when the grant never discovered one', async () => {
    const adapter = new AntigravityAdapter(grants({ accessToken: 'ya29.test', projectId: undefined }))
    const chunks = await collect(adapter.stream(request()))
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'fi-antigravity/no-project' } } })
  })

  it('projects a text reply: block lifecycle, usage, then finish', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      geminiText('Hello'),
      geminiText(' world', 'STOP', true),
    ])))
    const adapter = new AntigravityAdapter(grants(GRANT))
    const chunks = await collect(adapter.stream(request()))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello' },
      { type: 'text-delta', index: 0, text: ' world' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('separates reasoning from visible text into its own block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }] } }] } }),
      geminiText('Answer', 'STOP'),
    ])))
    const adapter = new AntigravityAdapter(grants(GRANT))
    const chunks = await collect(adapter.stream(request()))
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'thinking…' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking…' } })
    expect(chunks).toContainEqual({ type: 'block-start', index: 1, blockType: 'text' })
    expect(chunks[chunks.length - 1]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('assembles a function call into one tool-call block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      JSON.stringify({
        response: {
          candidates: [{
            content: { parts: [{ functionCall: { id: 'c1', name: 'get_time', args: { city: 'NYC' } } }] },
            finishReason: 'STOP',
          }],
        },
      }),
    ])))
    const adapter = new AntigravityAdapter(grants(GRANT))
    const chunks = await collect(adapter.stream(request()))
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'c1', name: 'get_time', arguments: '{"city":"NYC"}' },
    })
    expect(chunks[chunks.length - 1]).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('maps an upstream refusal to an error finish carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exhausted', { status: 429 })))
    const adapter = new AntigravityAdapter(grants(GRANT))
    const chunks = await collect(adapter.stream(request()))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'fi-antigravity/upstream', status: 429 } },
    })
  })

  it('sends the Antigravity envelope and CLI identity upstream', async () => {
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => sseResponse([geminiText('ok', 'STOP')]))
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = new AntigravityAdapter(grants(GRANT))
    await collect(adapter.stream(request({ system: 'Be brief.' })))
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('user-agent')).toContain('antigravity')
    expect(headers.get('authorization')).toBe('Bearer ya29.test')
    const envelope = JSON.parse(String(init.body)) as {
      project: string
      model: string
      request: { systemInstruction?: { parts?: { text: string }[] } }
      userAgent: string
      requestType: string
    }
    expect(envelope.project).toBe('project-1')
    expect(envelope.userAgent).toBe('antigravity')
    expect(envelope.requestType).toBe('agent')
  })
})
