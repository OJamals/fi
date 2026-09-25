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

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { ImageVariantId } from '@deepseek-ai/dsh-attachment'

import { AntigravityAdapter } from '../src/adapter.ts'
import type { AntigravityGrant } from '../src/adapter.ts'
import {
  ANTIGRAVITY_API_BASE_URL,
  ANTIGRAVITY_PROJECT_DISCOVERY_URL,
  ANTIGRAVITY_USER_AGENT,
} from '../src/auth/compat.ts'
import { ANTIGRAVITY_STATIC_CATALOG, antigravityModelName } from '../src/catalog.ts'
import { __resetAntigravityModelsCache } from '../src/transport.ts'

const GRANT: AntigravityGrant = { accessToken: 'ya29.test', projectId: 'project-1' }
const TEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const METADATA_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAABP2lDQ1BpY2MAABiVfZC/SwJxGMY/11WWWA05NBQcJU0FUUtTgYZOEfgj1Kbz/FGgdt33QprLoaloiEZrCaLZxhz6A4KgIQqirdWghpKLrw5aUM/yfnh4Xt6XB5TnvFEQ3RoUirYVDvm1eCKpuV5Q8dLPIGO6IczlSDAKIPSSMGwrzw+936PIeTe9rhfTO6/Xq8kFpbo7UY4FP1Yu+F/udEYYwBfgM0zLBkUDxku2KXkJ8BrrehqUODBlxRNJUPakn2vxieRUiy8lW9FwAJQaoOU6ONXBhfy2vCslv/dkirEI0AeMIggTwv9HpreZCRBgBmRfv3sQ2bnZ1pZnEXqeHOdtElyH0DhynM9Tx2mcgfoIta32/mYF5uugHrS91DFc7cPIQ9vzVWCoDNUbU7f0pqUCXdkNqJ/DQAKGb8G99g3j4l+x2lMbhgAAALRlWElmSUkqAAgAAAAGABIBAwABAAAAAQAAABoBBQABAAAAVgAAABsBBQABAAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA6AMAADhjAADoAwAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAAIAAAADoAQAAQAAAAEAAAAAAAAAhugH5gAAAAlwSFlzAAAD6AAAA+gBtXtSawAAAA9JREFUCJlj+M/AwPCfAQAH/wH/g4A9ZgAAAABJRU5ErkJggg=='

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
  }
}

/** Parse the JSON body one scripted fetch call received. */
function jsonBody(init: RequestInit): unknown {
  if (typeof init.body !== 'string') throw new Error('expected a JSON string request body')
  return JSON.parse(init.body) as unknown
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

/** A 200 Response carrying already-framed upstream SSE. */
function rawSseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`))
      controller.close()
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
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

/** Read one package-owned deterministic model-output golden. */
function golden(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.expected.json`, import.meta.url), 'utf8')) as unknown
}

afterEach(() => {
  vi.unstubAllGlobals()
  __resetAntigravityModelsCache()
})

describe('catalog', () => {
  it('advertises lowercase provider name for model selection', () => {
    const adapter = new AntigravityAdapter(grants(undefined))
    expect(adapter.providerInfo('antigravity')).toEqual({ id: 'antigravity', name: 'antigravity' })
  })

  it('uses the canonical captured provider metadata', () => {
    expect(ANTIGRAVITY_API_BASE_URL).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal')
    expect(ANTIGRAVITY_PROJECT_DISCOVERY_URL).toBe(
      'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist?alt=json',
    )
    expect(ANTIGRAVITY_USER_AGENT).toMatch(
      /^antigravity\/cli\/1\.2\.1 \(aidev_client; os_type=.+; arch=.+; cl=979485360; auth_method=consumer\)$/,
    )
  })

  it('ships the static Antigravity text and image models', () => {
    const ids = ANTIGRAVITY_STATIC_CATALOG.map(entry => entry.id)
    expect(ids).toContain('antigravity-claude-sonnet-4-6')
    expect(ids).toContain('antigravity-gemini-3.1-pro-high')
    expect(ids).toContain('claude-opus-4-6-thinking')
    expect(ids).toContain('gemini-3.1-flash-image')
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
    expect(models[0]).toMatchObject({ provider: 'antigravity', inputModalities: ['text', 'image'] })
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
    expect(models.some(model => model.id === 'gemini-3.1-flash-image')).toBe(true)
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
    expect(chunks.slice(0, -1)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello' },
      { type: 'text-delta', index: 0, text: ' world' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } },
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.at(-1)).toMatchObject({ replayState: { blocks: [{ type: 'text' }] } })
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
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('replays signed and unsigned text and reasoning as their exact native parts', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        JSON.stringify({
          response: {
            candidates: [{
              content: {
                parts: [
                  { text: 'thinking…', thought: true, thoughtSignature: 'reasoning-signature' },
                  { text: 'Answer ' },
                  { text: 'complete', thoughtSignature: 'answer-signature' },
                ],
              },
            }],
          },
        }),
        JSON.stringify({
          response: {
            candidates: [{
              content: { parts: [{ text: '', thoughtSignature: 'final-signature' }] },
              finishReason: 'STOP',
            }],
          },
        }),
      ]))
      .mockResolvedValueOnce(sseResponse([geminiText('done', 'STOP')]))
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = new AntigravityAdapter(grants(GRANT))
    const first = await collect(adapter.stream(request()))
    const assembler = new BlockAssembler()
    for (const chunk of first) assembler.push(chunk)
    const replayState = assembler.replayState
    expect(replayState).toMatchObject({
      response: {
        nativeParts: [
          { type: 'reasoning', text: 'thinking…', thoughtSignature: 'reasoning-signature' },
          { type: 'text', text: 'Answer ' },
          { type: 'text', text: 'complete', thoughtSignature: 'answer-signature' },
          { type: 'text', text: '', thoughtSignature: 'final-signature' },
        ],
      },
    })
    const assistant: Message = {
      id: 'assistant-text-signatures' as never,
      role: 'assistant',
      content: assembler.blocks(),
      source: { kind: 'model', provider: 'antigravity', model: 'claude-sonnet-4-6', replayState },
    }
    await collect(adapter.stream(request({ messages: [assistant, userMessage('continue')] })))
    const [, secondInit] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit]
    const envelope = jsonBody(secondInit) as {
      request: { contents: { role: string; parts: Record<string, unknown>[] }[] }
    }
    expect(envelope.request.contents[0]).toEqual({
      role: 'model',
      parts: [
        { text: 'thinking…', thought: true, thoughtSignature: 'reasoning-signature' },
        { text: 'Answer ' },
        { text: 'complete', thoughtSignature: 'answer-signature' },
        { text: '', thoughtSignature: 'final-signature' },
      ],
    })
  })

  it('replays signed original bytes after normalization, store reopen, and a model switch', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'fi-agy-output-image-'))
    try {
      const attachments = new LocalAttachmentStore(new Context(), { dshHome })
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(sseResponse([JSON.stringify({
          response: {
            candidates: [{
              content: {
                role: 'model',
                parts: [
                  { text: 'Before' },
                  {
                    inlineData: { mimeType: 'image/png', data: METADATA_PNG_BASE64 },
                    thoughtSignature: 'image-signature',
                  },
                  { text: 'After', thoughtSignature: 'after-signature' },
                ],
              },
              finishReason: 'STOP',
            }],
          },
        })]))
        .mockResolvedValueOnce(sseResponse([geminiText('continued', 'STOP')]))
      vi.stubGlobal('fetch', fetchSpy)
      const adapter = new AntigravityAdapter(grants(GRANT), () => attachments)

      const first = await collect(adapter.stream(request({ model: 'gemini-3.1-flash-image' })))
      const assembler = new BlockAssembler()
      for (const chunk of first) assembler.push(chunk)
      const blocks = assembler.blocks()
      expect(blocks.map(block => block.type)).toEqual(['text', 'image', 'text'])
      expect(first).toContainEqual({ type: 'block-start', index: 1, blockType: 'image' })
      expect(first).toContainEqual({ type: 'block-end', index: 1, block: blocks[1] })
      const image = blocks[1]
      if (image?.type !== 'image') throw new Error('expected generated image block')
      const normalized = await attachments.readImage(image.attachment)
      expect(normalized.ref).toEqual(image.attachment)
      expect(Buffer.from(normalized.data).equals(Buffer.from(METADATA_PNG_BASE64, 'base64'))).toBe(false)
      expect(assembler.replayState).toMatchObject({
        response: {
          nativeParts: [
            { type: 'text', text: 'Before' },
            {
              type: 'image',
              contentIndex: 1,
              thoughtSignature: 'image-signature',
              original: {
                mediaType: 'image/png',
                attachment: { bytes: Buffer.from(METADATA_PNG_BASE64, 'base64').byteLength },
              },
            },
            { type: 'text', text: 'After', thoughtSignature: 'after-signature' },
          ],
        },
        blocks: [{ type: 'text' }, { type: 'image' }, { type: 'text' }],
      })
      expect(JSON.stringify(assembler.replayState)).not.toContain(METADATA_PNG_BASE64)

      const assistant: Message = {
        id: 'generated-image' as never,
        role: 'assistant',
        content: blocks,
        source: {
          kind: 'model',
          provider: 'antigravity',
          model: 'gemini-3.1-flash-image',
          replayState: assembler.replayState,
        },
      }
      const reopened = new LocalAttachmentStore(new Context(), { dshHome })
      const replayAdapter = new AntigravityAdapter(grants(GRANT), () => reopened)
      await collect(replayAdapter.stream(request({
        model: 'gemini-3.1-pro-high',
        messages: [assistant, userMessage('continue')],
      })))
      const [, secondInit] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit]
      const envelope = jsonBody(secondInit) as {
        model: string
        request: { contents: Array<{ role: string; parts: Record<string, unknown>[] }> }
      }
      expect(envelope.model).toBe('gemini-pro-agent')
      expect(envelope.request.contents[0]).toEqual({
        role: 'model',
        parts: [
          { text: 'Before' },
          {
            inlineData: { mimeType: 'image/png', data: METADATA_PNG_BASE64 },
            thoughtSignature: 'image-signature',
          },
          { text: 'After', thoughtSignature: 'after-signature' },
        ],
      })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('preflights generated image limits before decoding or publishing the rejected image', async () => {
    const saved = vi.fn(async () => [])
    const attachments = {
      imageLimits: {
        maxImageBytes: 1024,
        maxImagePixels: 1024,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1024,
        mediaTypes: ['image/png'],
      },
      readImageRequest: vi.fn(),
      saveImages: saved,
    }
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([JSON.stringify({
      response: {
        candidates: [{
          content: { parts: [
            { inlineData: { mimeType: 'image/png', data: TEST_PNG_BASE64 } },
            { inlineData: { mimeType: 'image/png', data: TEST_PNG_BASE64 } },
          ] },
          finishReason: 'STOP',
        }],
      },
    })])))
    const adapter = new AntigravityAdapter(grants(GRANT), () => attachments as never)
    const chunks = await collect(adapter.stream(request({ model: 'gemini-3.1-flash-image' })))
    expect(saved).not.toHaveBeenCalled()
    expect(chunks.some(chunk => chunk.type === 'block-start')).toBe(false)
    expect(chunks).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'fi-antigravity/invalid-image-output',
          message: 'Antigravity image output failed attachment admission',
        },
      },
    }])
  })

  it('rejects malformed output base64 and cancels the upstream reader', async () => {
    const cancelled = vi.fn()
    const saved = vi.fn(async () => [])
    const encoder = new TextEncoder()
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          response: {
            candidates: [{
              content: { parts: [{ inlineData: { mimeType: 'image/png', data: '***' } }] },
              finishReason: 'STOP',
            }],
          },
        })}\n\n`))
      },
      cancel: cancelled,
    }), { headers: { 'Content-Type': 'text/event-stream' } })
    vi.stubGlobal('fetch', vi.fn(async () => upstream))
    const adapter = new AntigravityAdapter(grants(GRANT), () => ({
      imageLimits: {
        maxImageBytes: 1024,
        maxImagePixels: 1024,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1024,
        mediaTypes: ['image/png'],
      },
      saveImages: saved,
    }) as never)
    const chunks = await collect(adapter.stream(request({ model: 'gemini-3.1-flash-image' })))
    expect(saved).not.toHaveBeenCalled()
    expect(chunks.some(chunk => chunk.type === 'block-start')).toBe(false)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'fi-antigravity/invalid-image-output' } },
    })
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('decodes the raster and rejects a declared media type that does not match the bytes', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'fi-agy-output-mime-'))
    try {
      const attachments = new LocalAttachmentStore(new Context(), { dshHome })
      vi.stubGlobal('fetch', vi.fn(async () => sseResponse([JSON.stringify({
        response: {
          candidates: [{
            content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: TEST_PNG_BASE64 } }] },
            finishReason: 'STOP',
          }],
        },
      })])))
      const adapter = new AntigravityAdapter(grants(GRANT), () => attachments)
      const chunks = await collect(adapter.stream(request({ model: 'gemini-3.1-flash-image' })))
      expect(chunks.some(chunk => chunk.type === 'block-start')).toBe(false)
      expect(chunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'fi-antigravity/invalid-image-output' } },
      })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('fails closed when a signed provider part has no supported replay projection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([JSON.stringify({
      response: {
        candidates: [{
          content: {
            parts: [
              { text: 'partial' },
              { fileData: { fileUri: 'gs://private/object' }, thoughtSignature: 'signed-file' },
            ],
          },
          finishReason: 'STOP',
        }],
      },
    })])))
    const adapter = new AntigravityAdapter(grants(GRANT))
    const chunks = await collect(adapter.stream(request()))
    expect(chunks.filter(chunk => chunk.type === 'finish')).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'fi-antigravity/invalid-signature',
          message: 'Antigravity returned invalid native replay metadata',
        },
      },
    }])
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(false)
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
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('persists and replays a function-call thought signature on the next request', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(sseResponse([JSON.stringify({
        response: {
          candidates: [{
            content: {
              parts: [{
                functionCall: { id: 'c1', name: 'get_time', args: { city: 'NYC' } },
                thoughtSignature: 'signed-thought',
              }],
            },
            finishReason: 'STOP',
          }],
        },
      })]))
      .mockResolvedValueOnce(sseResponse([geminiText('done', 'STOP')]))
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = new AntigravityAdapter(grants(GRANT))
    const first = await collect(adapter.stream(request()))
    const assembler = new BlockAssembler()
    for (const chunk of first) assembler.push(chunk)
    const replayState = assembler.replayState
    expect(replayState).toMatchObject({ blocks: [{ type: 'tool-call', thoughtSignature: 'signed-thought' }] })
    const assistant: Message = {
      id: 'assistant-1' as never,
      role: 'assistant',
      content: assembler.blocks(),
      source: { kind: 'model', provider: 'antigravity', model: 'claude-sonnet-4-6', replayState },
    }
    const result: Message = {
      id: 'result-1' as never,
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1' as never, content: [{ type: 'text', text: '12:00' }] }],
      source: { kind: 'tool', callId: 'c1' as never },
    }
    await collect(adapter.stream(request({ messages: [assistant, result] })))
    const [, secondInit] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit]
    const envelope = jsonBody(secondInit) as {
      request: { contents: { role: string; parts: { thoughtSignature?: string }[] }[] }
    }
    expect({
      stream: first,
      finishCount: first.filter(chunk => chunk.type === 'finish').length,
      replayedAssistantPart: envelope.request.contents[0]?.parts[0],
    }).toEqual(golden('thought-signature-roundtrip'))
  })

  it('closes open blocks and emits one terminal finish for an upstream error event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rawSseResponse([
      `data: ${geminiText('partial')}`,
      'event: error\ndata: {"error":{"message":"broken"}}',
    ])))
    const adapter = new AntigravityAdapter(grants(GRANT))
    const chunks = await collect(adapter.stream(request()))
    expect(chunks.filter(chunk => chunk.type === 'finish')).toEqual([{
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'fi-antigravity/upstream', message: 'Antigravity stream failed' } },
    }])
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } })
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  it('projects durable image refs through bounded attachment request versions', async () => {
    const imageRef = {
      attachmentId: 'image-1' as never,
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
      name: 'pixel.png',
    }
    const dshHome = await mkdtemp(join(tmpdir(), 'fi-agy-input-'))
    onTestFinished(() => rm(dshHome, { recursive: true, force: true }))
    const attachments = new LocalAttachmentStore(new Context(), {
      dshHome, maxImageBytes: 2 * 1024 * 1024, maxImagePixels: 4096 * 4096,
    })
    const readImageRequest = vi.spyOn(attachments, 'readImageRequest').mockResolvedValue({
      variantId: ImageVariantId('input-variant'),
      attachment: imageRef,
      data: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    })
    const fetchSpy = vi.fn(async () => sseResponse([geminiText('seen', 'STOP')]))
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = new AntigravityAdapter(grants(GRANT), () => attachments)
    await collect(adapter.stream(request({
      messages: [{
        id: 'image-message' as never,
        role: 'user',
        content: [{ type: 'image', attachment: imageRef }],
        source: { kind: 'user' },
      }],
    })))
    expect(readImageRequest).toHaveBeenCalledWith(
      imageRef,
      { maxPixels: 4096 * 4096, maxBytes: 2 * 1024 * 1024 },
      undefined,
    )
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const envelope = jsonBody(init) as {
      request: { contents: { parts: Array<{ inlineData?: { mimeType: string; data: string } }> }[] }
    }
    expect(envelope.request.contents[0]?.parts).toContainEqual({
      inlineData: { mimeType: 'image/png', data: 'AQID' },
    })
  })

  it('projects a canonical local attachment through an ordinary inference request', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'fi-agy-image-'))
    try {
      const attachments = new LocalAttachmentStore(new Context(), { dshHome })
      const data = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
        'base64',
      ))
      const imageRef = await attachments.saveImage({ data, mediaType: 'image/png', name: 'pixel.png' })
      const fetchSpy = vi.fn(async () => sseResponse([geminiText('seen', 'STOP')]))
      vi.stubGlobal('fetch', fetchSpy)
      const adapter = new AntigravityAdapter(grants(GRANT), () => attachments)
      const chunks = await collect(adapter.stream(request({
        messages: [{
          id: 'canonical-image' as never,
          role: 'user',
          content: [{ type: 'text', text: 'Describe this.' }, { type: 'image', attachment: imageRef }],
          source: { kind: 'user' },
        }],
      })))
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
      const envelope = jsonBody(init) as {
        request: { contents: { parts: Array<{ inlineData?: { mimeType: string; data: string } }> }[] }
      }
      expect(envelope.request.contents[0]?.parts).toContainEqual({
        inlineData: { mimeType: 'image/png', data: Buffer.from(data).toString('base64') },
      })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('keeps a tool result function response and projects its durable image ref', async () => {
    const imageRef = {
      attachmentId: 'tool-image-1' as never,
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    }
    const dshHome = await mkdtemp(join(tmpdir(), 'fi-agy-tool-input-'))
    onTestFinished(() => rm(dshHome, { recursive: true, force: true }))
    const attachments = new LocalAttachmentStore(new Context(), {
      dshHome, maxImageBytes: 1024, maxImagePixels: 1024,
    })
    vi.spyOn(attachments, 'readImageRequest').mockResolvedValue({
      variantId: ImageVariantId('tool-input-variant'),
      attachment: imageRef,
      data: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    })
    const fetchSpy = vi.fn(async () => sseResponse([geminiText('seen', 'STOP')]))
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = new AntigravityAdapter(grants(GRANT), () => attachments)
    const assistant: Message = {
      id: 'assistant-tool' as never,
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1' as never, name: 'inspect', arguments: '{}' }],
      source: { kind: 'model', provider: 'antigravity', model: 'claude-sonnet-4-6' },
    }
    const result: Message = {
      id: 'result-image' as never,
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'c1' as never,
        content: [{ type: 'text', text: 'captured' }, { type: 'image', attachment: imageRef }],
      }],
      source: { kind: 'tool', callId: 'c1' as never },
    }
    await collect(adapter.stream(request({ messages: [assistant, result] })))
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const envelope = jsonBody(init) as {
      request: { contents: Array<{ parts: Array<{ functionResponse?: unknown; inlineData?: unknown }> }> }
    }
    expect(envelope.request.contents[1]?.parts[0]?.functionResponse).toBeDefined()
    expect(envelope.request.contents[2]?.parts).toContainEqual({
      inlineData: { mimeType: 'image/png', data: 'AQID' },
    })
  })

  it('fails closed when an image reaches an adapter without the attachment service', async () => {
    const adapter = new AntigravityAdapter(grants(GRANT))
    await expect(collect(adapter.stream(request({
      messages: [{
        id: 'image-message' as never,
        role: 'user',
        content: [{
          type: 'image',
          attachment: { attachmentId: 'image-1' as never, mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
        }],
        source: { kind: 'user' },
      }],
    })))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
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
    const envelope = jsonBody(init) as {
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

  it('sends standard system and tool context with image-model response modalities', async () => {
    const fetchSpy = vi.fn(async () => sseResponse([geminiText('ok', 'STOP')]))
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = new AntigravityAdapter(grants(GRANT))
    await collect(adapter.stream(request({
      model: 'gemini-3.1-flash-image',
      system: 'Use the available tools when needed.',
      tools: [{ name: 'read_file', description: 'Read one file', parameters: { type: 'object', properties: {} } }],
    })))
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const envelope = jsonBody(init) as {
      request: {
        generationConfig: { responseModalities?: string[] }
        systemInstruction?: { parts?: Array<{ text: string }> }
        tools?: Array<{ functionDeclarations?: Array<{ name: string }> }>
      }
    }
    expect(envelope.request.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE'])
    expect(envelope.request.systemInstruction?.parts).toEqual([{ text: 'Use the available tools when needed.' }])
    expect(envelope.request.tools?.[0]?.functionDeclarations?.[0]?.name).toBe('read_file')
  })
})
