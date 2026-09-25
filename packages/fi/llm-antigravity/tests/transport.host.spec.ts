/** Native Gemini transport parity against scripted Cloud Code responses. */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  callAntigravityChat,
  callAntigravityGeminiNative,
  callAntigravityImageEdits,
  callAntigravityImageGenerations,
  transformAntigravityEvent,
} from '../src/transport.ts'

const ACCOUNT = {
  token: { accessToken: 'ya29.test', antigravityProjectId: 'project-1' },
}

/** Parse the JSON body one scripted fetch call received. */
function jsonBody(init: RequestInit): unknown {
  if (typeof init.body !== 'string') throw new Error('expected a JSON string request body')
  return JSON.parse(init.body) as unknown
}

function upstreamSse(payloads: readonly unknown[], terminateFinalFrame = true): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [index, payload] of payloads.entries()) {
        const terminator = terminateFinalFrame || index < payloads.length - 1 ? '\n\n' : ''
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}${terminator}`))
      }
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'upstream-1' } })
}

function openResponse(
  payload: string | undefined,
  contentType: string,
  cancelled: () => void,
): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (payload !== undefined) controller.enqueue(encoder.encode(payload))
    },
    pull() { return new Promise<void>(() => {}) },
    cancel: cancelled,
  }), { headers: { 'content-type': contentType } })
}

async function settlesWithin<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('operation did not settle')) }, 250)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('callAntigravityGeminiNative', () => {
  it('collects nonstream search and retains native grounding metadata', async () => {
    const fetchSpy = vi.fn(async () => upstreamSse([{
      response: {
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ text: 'Grounded answer' }] },
          finishReason: 'STOP',
          groundingMetadata: {
            searchEntryPoint: { renderedContent: '<div>search</div>' },
            groundingChunks: [{ web: { uri: 'https://example.test/source', title: 'Source' } }],
            groundingSupports: [{ segment: { text: 'Grounded answer' }, groundingChunkIndices: [0] }],
          },
        }],
      },
    }]))
    vi.stubGlobal('fetch', fetchSpy)
    const response = await callAntigravityGeminiNative({
      action: 'generateContent',
      model: 'gemini-3.1-pro-high',
      account: ACCOUNT,
      body: {
        contents: [{ role: 'user', parts: [{ text: 'search the web' }] }],
        tools: [{ googleSearch: {} }],
      },
    })
    expect(response.ok).toBe(true)
    expect(response.headers.get('x-upstream-request-id')).toBe('upstream-1')
    await expect(response.json()).resolves.toMatchObject({
      candidates: [{
        groundingMetadata: {
          searchEntryPoint: { renderedContent: '<div>search</div>' },
          groundingChunks: [{ web: { uri: 'https://example.test/source' } }],
        },
      }],
    })
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.redirect).toBe('error')
    const envelope = jsonBody(init) as {
      project: string
      request: { tools: unknown[] }
    }
    expect(envelope.project).toBe('project-1')
    expect(envelope.request.tools).toEqual([{ googleSearch: {} }])
  })

  it('collects a final SSE data line without a frame terminator', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstreamSse([{
      response: { candidates: [{ content: { parts: [{ text: 'Final response' }] }, finishReason: 'STOP' }] },
    }], false)))
    const response = await callAntigravityGeminiNative({
      action: 'generateContent',
      model: 'gemini-3.1-pro-high',
      account: ACCOUNT,
      body: { contents: [{ role: 'user', parts: [{ text: 'search' }] }] },
    })
    await expect(response.json()).resolves.toMatchObject({
      candidates: [{ content: { parts: [{ text: 'Final response' }] } }],
    })
  })

  it('normalizes native aliases and rejects ambiguous or invalid media before fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const ambiguous = await callAntigravityGeminiNative({
      action: 'generateContent',
      model: 'gemini-3.1-pro-high',
      account: ACCOUNT,
      body: { generationConfig: {}, generation_config: {}, contents: [] },
    })
    expect(ambiguous.status).toBe(400)
    await expect(ambiguous.json()).resolves.toMatchObject({ error: { status: 'INVALID_ARGUMENT' } })
    const invalidBase64 = await callAntigravityGeminiNative({
      action: 'generateContent',
      model: 'gemini-3.1-pro-high',
      account: ACCOUNT,
      body: {
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/png', data: '***' } }] }],
      },
    })
    expect(invalidBase64.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('preserves native file handles and image-generation settings in the Cloud Code request', async () => {
    const fetchSpy = vi.fn(async () => upstreamSse([{
      response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
    }]))
    vi.stubGlobal('fetch', fetchSpy)
    await callAntigravityGeminiNative({
      action: 'generateContent',
      model: 'gemini-3.1-flash-image',
      account: ACCOUNT,
      body: {
        generation_config: {
          response_modalities: ['TEXT', 'IMAGE'],
          image_config: { aspect_ratio: '16:9', image_size: '2K' },
        },
        contents: [{
          role: 'user',
          parts: [{ file_data: { file_uri: 'gs://project/input.png', mime_type: 'image/png' } }],
        }],
      },
    })
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const envelope = jsonBody(init) as {
      request: {
        generationConfig: Record<string, unknown>
        contents: Array<{ parts: Record<string, unknown>[] }>
      }
    }
    expect(envelope.request.generationConfig).toEqual({
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
    })
    expect(envelope.request.contents[0]?.parts[0]).toEqual({
      fileData: { fileUri: 'gs://project/input.png', mimeType: 'image/png' },
    })
  })

  it('refuses a native request that exceeds its configured Cloud Code envelope bound', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const response = await callAntigravityGeminiNative({
      action: 'generateContent',
      model: 'gemini-3.1-pro-high',
      account: ACCOUNT,
      config: { native: { 'max-request-bytes': 256 } },
      body: { contents: [{ role: 'user', parts: [{ text: 'x'.repeat(256) }] }] },
    })
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 413, status: 'RESOURCE_EXHAUSTED' },
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('enforces configured SSE bounds on collected responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstreamSse([{
      response: { candidates: [{ content: { parts: [{ text: 'too long' }] } }] },
    }])))
    await expect(callAntigravityGeminiNative({
      action: 'generateContent',
      model: 'gemini-3.1-pro-high',
      account: ACCOUNT,
      config: { streaming: { 'max-line-bytes': 8, 'max-frame-bytes': 16 } },
      body: { contents: [{ role: 'user', parts: [{ text: 'search' }] }] },
    })).rejects.toThrow('exceeded')
  })

  it('bounds the total bytes across individually valid native SSE frames', async () => {
    const cancelled = vi.fn()
    const encoder = new TextEncoder()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const text of ['first response', 'second response']) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            response: { candidates: [{ content: { parts: [{ text }] } }] },
          })}\n\n`))
        }
      },
      cancel: cancelled,
    }), { headers: { 'content-type': 'text/event-stream' } })))
    await expect(callAntigravityGeminiNative({
      action: 'generateContent',
      model: 'gemini-3.1-pro-high',
      account: ACCOUNT,
      config: {
        streaming: { 'max-line-bytes': 1024, 'max-frame-bytes': 1024 },
        native: { 'max-response-bytes': 140 },
      },
      body: { contents: [{ role: 'user', parts: [{ text: 'search' }] }] },
    })).rejects.toThrow('response exceeded 140 bytes')
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('cancels the native upstream reader when the operation aborts', async () => {
    const cancelled = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}) },
      cancel: cancelled,
    }), { headers: { 'content-type': 'text/event-stream' } })))
    const controller = new AbortController()
    const pending = callAntigravityGeminiNative({
      action: 'generateContent',
      model: 'gemini-3.1-pro-high',
      account: ACCOUNT,
      signal: controller.signal,
      body: { contents: [{ role: 'user', parts: [{ text: 'search' }] }] },
    })
    await Promise.resolve()
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('aborts the native upstream reader when its response consumer cancels', async () => {
    const cancelled = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}) },
      cancel: cancelled,
    }), { headers: { 'content-type': 'text/event-stream' } })))
    const response = await callAntigravityGeminiNative({
      action: 'streamGenerateContent',
      model: 'gemini-3.1-pro-high',
      account: ACCOUNT,
      body: { contents: [{ role: 'user', parts: [{ text: 'search' }] }] },
    })
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('expected native response body')
    const pendingRead = reader.read()
    await Promise.resolve()
    await expect(Promise.race([
      reader.cancel('consumer stopped'),
      new Promise((_, reject) => setTimeout(() => { reject(new Error('cancel timed out')) }, 250)),
    ])).resolves.toBeUndefined()
    await expect(pendingRead).resolves.toEqual({ done: true, value: undefined })
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('redacts non-OK and in-band provider diagnostics', async () => {
    const secret = 'account@example.test bearer-secret request-prompt'
    const nativeCancelled = vi.fn()
    const chatCancelled = vi.fn()
    const rejectedResponse = (status: number, cancelled: () => void): Response => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(secret))
        },
        cancel: cancelled,
      }),
      { status },
    )
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(rejectedResponse(401, nativeCancelled))
      .mockResolvedValueOnce(upstreamSse([{ error: { code: 503, message: secret } }]))
      .mockResolvedValueOnce(rejectedResponse(429, chatCancelled))
    vi.stubGlobal('fetch', fetchSpy)

    const rejected = await callAntigravityGeminiNative({
      action: 'generateContent', model: 'gemini-3.1-pro-high', account: ACCOUNT,
      body: { contents: [{ role: 'user', parts: [{ text: 'search' }] }] },
    })
    expect(await rejected.text()).toBe('{"error":{"code":401,"message":"Antigravity upstream answered 401","status":"UPSTREAM_ERROR"}}')

    const inBand = await callAntigravityGeminiNative({
      action: 'generateContent', model: 'gemini-3.1-pro-high', account: ACCOUNT,
      body: { contents: [{ role: 'user', parts: [{ text: 'search' }] }] },
    })
    expect(await inBand.text()).toBe('{"error":{"code":503,"message":"Antigravity upstream answered 503","status":"UPSTREAM_ERROR"}}')

    const chat = await callAntigravityChat({
      account: ACCOUNT,
      body: { model: 'gemini-3.1-pro-high', messages: [{ role: 'user', content: 'search' }] },
    })
    expect(await chat.text()).toBe('{"error":{"message":"Antigravity upstream answered 429","type":"upstream_error"}}')
    expect(fetchSpy.mock.calls.every(([, init]) => (init as RequestInit).redirect === 'error')).toBe(true)
    expect(nativeCancelled).toHaveBeenCalledOnce()
    expect(chatCancelled).toHaveBeenCalledOnce()
  })

  it('rejects and cancels HTTP 200 non-SSE bodies without reading diagnostics', async () => {
    const secret = 'account@example.test bearer-secret request-prompt'
    const nativeCancelled = vi.fn()
    const chatCancelled = vi.fn()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(openResponse(secret, 'text/plain', nativeCancelled))
      .mockResolvedValueOnce(openResponse(secret, 'application/json', chatCancelled)))

    const native = await settlesWithin(callAntigravityGeminiNative({
      action: 'generateContent', model: 'gemini-3.1-pro-high', account: ACCOUNT,
      body: { contents: [{ role: 'user', parts: [{ text: 'search' }] }] },
    }))
    expect(native.status).toBe(502)
    expect(await native.text()).not.toContain(secret)

    const chat = await settlesWithin(callAntigravityChat({
      account: ACCOUNT,
      body: { stream: true, model: 'gemini-3.1-pro-high', messages: [{ role: 'user', content: 'search' }] },
    }))
    expect(chat.status).toBe(502)
    expect(await chat.text()).not.toContain(secret)
    expect(nativeCancelled).toHaveBeenCalledOnce()
    expect(chatCancelled).toHaveBeenCalledOnce()
  })

  it('settles and cancels upstream after sanitized in-band stream errors', async () => {
    const secret = 'account@example.test bearer-secret request-prompt'
    const payload = `data: ${JSON.stringify({ error: { code: 503, message: secret } })}\n\n`
    const nativeCancelled = vi.fn()
    const chatCancelled = vi.fn()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(openResponse(payload, 'text/event-stream', nativeCancelled))
      .mockResolvedValueOnce(openResponse(payload, 'text/event-stream', chatCancelled)))

    const native = await callAntigravityGeminiNative({
      action: 'streamGenerateContent', model: 'gemini-3.1-pro-high', account: ACCOUNT,
      body: { contents: [{ role: 'user', parts: [{ text: 'search' }] }] },
    })
    const nativeBody = await settlesWithin(native.text())
    expect(nativeBody).toContain('Antigravity upstream answered 503')
    expect(nativeBody).not.toContain(secret)

    const chat = await callAntigravityChat({
      account: ACCOUNT,
      body: { stream: true, model: 'gemini-3.1-pro-high', messages: [{ role: 'user', content: 'search' }] },
    })
    const chatBody = await settlesWithin(chat.text())
    expect(chatBody).toContain('Antigravity upstream stream failed')
    expect(chatBody).not.toContain(secret)
    expect(nativeCancelled).toHaveBeenCalledOnce()
    expect(chatCancelled).toHaveBeenCalledOnce()
  })

  it('suppresses exact repeated function-call ids and rejects conflicting repeats', async () => {
    const functionCall = {
      response: { candidates: [{ content: { parts: [{
        functionCall: { id: 'call-1', name: 'lookup', args: { query: 'x' } },
        thoughtSignature: 'signature-1',
      }] } }] },
    }
    const finish = {
      response: { candidates: [{
        content: { parts: [{
          functionCall: { id: 'call-1', name: 'lookup', args: { query: 'x' } },
          thoughtSignature: 'signature-1',
        }] },
        finishReason: 'STOP',
      }] },
    }
    vi.stubGlobal('fetch', vi.fn(async () => upstreamSse([functionCall, finish])))
    const response = await callAntigravityChat({
      account: ACCOUNT,
      body: { stream: true, model: 'gemini-3.1-pro-high', messages: [{ role: 'user', content: 'search' }] },
    })
    const chunks = (await response.text()).split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)) as { choices: Array<{ delta: { tool_calls?: unknown[] }; finish_reason: string | null }> })
    expect(chunks.flatMap(chunk => chunk.choices[0]?.delta.tool_calls ?? [])).toHaveLength(1)
    expect(chunks.filter(chunk => chunk.choices[0]?.finish_reason === 'tool_calls')).toHaveLength(1)

    const conflict = structuredClone(finish)
    conflict.response.candidates[0]!.content.parts[0]!.functionCall.args.query = 'changed'
    vi.stubGlobal('fetch', vi.fn(async () => upstreamSse([functionCall, conflict])))
    const conflicting = await callAntigravityChat({
      account: ACCOUNT,
      body: { stream: true, model: 'gemini-3.1-pro-high', messages: [{ role: 'user', content: 'search' }] },
    })
    await expect(conflicting.text()).rejects.toThrow('conflicting payload')
  })
})

describe('Antigravity image calls', () => {
  it('projects image generation through the native Gemini collector', async () => {
    const fetchSpy = vi.fn(async () => upstreamSse([{
      response: {
        candidates: [{
          content: {
            role: 'model',
            parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }],
          },
          finishReason: 'STOP',
        }],
      },
    }]))
    vi.stubGlobal('fetch', fetchSpy)
    const response = await callAntigravityImageGenerations({
      account: ACCOUNT,
      body: {
        model: 'gemini-3.1-flash-image',
        prompt: 'Draw a test',
        size: '1536x1024',
        quality: 'high',
        response_format: 'b64_json',
      },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: [{ b64_json: 'aW1hZ2U=', revised_prompt: 'Draw a test' }],
    })
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const envelope = jsonBody(init) as {
      model: string
      request: {
        contents: Array<{ role: string; parts: unknown[] }>
        generationConfig: Record<string, unknown>
      }
    }
    expect(envelope.model).toBe('gemini-3.1-flash-image')
    expect(envelope.request.contents).toEqual([{
      role: 'user',
      parts: [{ text: 'Draw a test' }],
    }])
    expect(envelope.request.generationConfig).toEqual({
      candidateCount: 1,
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '3:2', imageSize: '2K' },
    })
  })

  it('projects image edits without a second Gemini response parser', async () => {
    const fetchSpy = vi.fn(async () => upstreamSse([{
      response: {
        candidates: [{
          content: { parts: [{ inlineData: { mimeType: 'image/webp', data: 'ZWRpdA==' } }] },
          finishReason: 'STOP',
        }],
      },
    }]))
    vi.stubGlobal('fetch', fetchSpy)
    const response = await callAntigravityImageEdits({
      account: ACCOUNT,
      body: {
        model: 'gemini-3.1-flash-image',
        prompt: 'Add a hat',
        images: [
          { type: 'image_url', url: 'data:image/png;base64,aW1hZ2U=' },
          { url: 'https://example.test/reference.webp', media_type: 'image/webp' },
        ],
      },
    })
    expect(response.status).toBe(200)
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const envelope = jsonBody(init) as {
      request: { contents: Array<{ parts: unknown[] }> }
    }
    expect(envelope.request.contents[0]?.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
      { fileData: { fileUri: 'https://example.test/reference.webp', mimeType: 'image/webp' } },
      { text: 'Add a hat' },
    ])
  })

  it('rejects opaque image ids before the native transport fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const response = await callAntigravityImageEdits({
      account: ACCOUNT,
      body: {
        model: 'gemini-3.1-flash-image',
        prompt: 'Edit',
        image: { file_id: 'opaque-id' },
      },
    })
    expect(response.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('transformAntigravityEvent', () => {
  it('does not turn unsafe or truncated terminal reasons into executable tool calls', () => {
    type Event = { choices: Array<{ finish_reason: string | null }> }
    const event = (finishReason: string): Event | null => {
      const translated: unknown = transformAntigravityEvent({
        response: { candidates: [{ content: { parts: [] }, finishReason }] },
      }, 'gemini-3.1-pro-high', 'request-1', true)
      return translated as Event | null
    }
    expect(event('SAFETY')?.choices[0]?.finish_reason).toBe('content_filter')
    expect(event('MAX_TOKENS')?.choices[0]?.finish_reason).toBe('length')
    expect(event('MALFORMED_FUNCTION_CALL')?.choices[0]?.finish_reason).toBe('content_filter')
    expect(event('STOP')?.choices[0]?.finish_reason).toBe('tool_calls')
  })
})
