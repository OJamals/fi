/** Transport failures preserve response limits and reject invalid image references. */
import { afterEach, expect, it, vi } from 'vitest'
import {
  __resetAntigravityModelsCache, callAntigravityChat, callAntigravityImageGenerations, listAntigravityModels,
  staticAntigravityTextModelIds,
  callAntigravityGeminiNative,
} from '../src/transport.ts'

const account = { token: { accessToken: 'fixture', antigravityProjectId: 'project' } }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); __resetAntigravityModelsCache() })

it.each(['chat', 'native'] as const)('finishes %s response rejection when body cancellation fails', async (kind) => {
  for (const status of [200, 503]) {
    const cancel = vi.fn(() => { throw new Error('cancel failure') })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status })))
    const result = kind === 'chat'
      ? await callAntigravityChat({ account, body: {} })
      : await callAntigravityGeminiNative({ account, model: 'gemini', action: 'generateContent', body: {} })
    expect(result.status).toBe(status === 200 ? 502 : 503)
    expect(cancel).toHaveBeenCalledOnce()
  }
})

it.each([
  ['\n\ndata: {}\n\ndata: {"candidates":[{"finishReason":"STOP"}]}\n\ndata: [DONE]\n\n', undefined],
  ['data: {}\n\n', 'before finishReason'],
  ['data: [DONE]\n\n', 'before finishReason'],
  ['data: broken\n\n', 'Malformed'],
] as const)('projects terminal chat SSE case %#', async (body, error) => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } })))
  const response = await callAntigravityChat({ account, body: { model: 'gemini', messages: [], stream: true } })
  if (error === undefined) expect(await response.text()).toContain('[DONE]')
  else await expect(response.text()).rejects.toThrow(error)
})

it('preserves native SSE event names and ignores null payloads', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('data: null\n\ndata: {}\n\nevent: progress\ndata: {"response":{"usageMetadata":{"totalTokenCount":3}}}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })))
  const response = await callAntigravityGeminiNative({ account, model: 'gemini', action: 'streamGenerateContent', body: {}, signal: new AbortController().signal })
  const output = await response.text()
  expect(output).toContain('event: progress')
  expect(output).toContain('"totalTokenCount":3')
  expect(output).not.toContain('data: null')
})

it('uses a configured endpoint and translates cached and reasoning usage', async () => {
  vi.stubEnv('ANTIGRAVITY_API_URL', 'https://fixture.invalid/cloud-code')
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"cachedContentTokenCount":2,"thoughtsTokenCount":4}}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }))
  vi.stubGlobal('fetch', fetcher)
  const response = await callAntigravityChat({ account, body: null })
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://fixture.invalid/cloud-code')
  expect(await response.json()).toMatchObject({ usage: {
    prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 4 },
  } })
})

it.each([undefined, { generationConfig: 'provider-extension' }])('retains native metadata without candidates %#', async (body) => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('data: {"usageMetadata":{"totalTokenCount":3}}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })))
  const response = await callAntigravityGeminiNative({ account, model: 'gemini', action: 'generateContent', body })
  expect(await response.json()).toEqual({ usageMetadata: { totalTokenCount: 3 } })
})

it('reports missing generated images when native response contains metadata only', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('data: {"usageMetadata":{}}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })))
  const response = await callAntigravityImageGenerations({ account, body: { model: 'image', prompt: 'draw' } })
  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ error: { message: 'Antigravity returned no generated image' } })
})

it('supplies an abort error when the caller cancels without a reason', async () => {
  const controller = new AbortController()
  controller.abort(null)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } })))
  await expect(callAntigravityGeminiNative({ account, model: 'gemini', action: 'generateContent', body: {}, signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' })
})

it.each([
  ['data: invalid\n', { 'max-line-bytes': 5 }],
  ['data: invalid', { 'max-line-bytes': 5 }],
  ['data: {}\ndata: {}', { 'max-frame-bytes': 12 }],
  ['data: {}\ndata: {}\n', { 'max-frame-bytes': 12 }],
  [Uint8Array.from([...new TextEncoder().encode('data:'), 0xc2]), { 'max-line-bytes': 5 }],
] as const)('enforces SSE bounds for case %#', async (body, streaming) => {
  const cancel = vi.fn(() => { throw new Error('cancel failed') })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(typeof body === 'string' ? new TextEncoder().encode(body) : body)
      if (typeof body !== 'string') controller.close()
    }, cancel,
  }), { headers: { 'content-type': 'text/event-stream' } })))
  await expect(callAntigravityChat({ account, body: { model: 'gemini', messages: [] }, config: { streaming } })).rejects.toThrow(/exceeded/)
})

it('rejects a native envelope exceeding its byte budget', async () => {
  const response = await callAntigravityGeminiNative({ account, model: 'gemini', action: 'generateContent', body: {}, config: { native: { 'max-request-bytes': 100 } } })
  expect(response.status).toBe(413)
})

it('rejects inline bytes above the native media budget', async () => {
  const response = await callAntigravityGeminiNative({ account, model: 'gemini', action: 'generateContent', body: { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }] }] }, config: { native: { 'max-inline-media-bytes': 1 } } })
  expect(response.status).toBe(413)
})

it('rejects a chat request above the protocol byte limit', async () => {
  expect((await callAntigravityChat({ account, body: { model: 'gemini', messages: [{ role: 'user', content: 'a'.repeat(20 * 1024 * 1024) }] } })).status).toBe(413)
})

it('rejects obsolete native image fields', async () => {
  const response = await callAntigravityGeminiNative({ account, model: 'gemini', action: 'generateContent', body: { contents: [{ parts: [{ image: 'obsolete' }] }] } })
  expect(response.status).toBe(400)
})

it('forwards image-generation upstream failures', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })))
  const response = await callAntigravityImageGenerations({ account, body: { model: 'image', prompt: 'draw' }, config: {}, signal: new AbortController().signal })
  expect(response.status).toBe(503)
})

it('shares catalog refreshes, serves stale entries, and drops responses from a cleared cache', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const pending = Promise.withResolvers<Response>()
  const catalog = { models: { 'gemini-3.7-flash-high': {}, 'image-fixture': {} }, defaultAgentModelId: 'gemini-3.7-flash-high', imageGenerationModelIds: ['image-fixture', 42, 'missing'] }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(catalog)).mockReturnValueOnce(pending.promise)
  vi.stubGlobal('fetch', fetcher)
  const initial = await listAntigravityModels(account)
  expect(initial.map(model => model.id)).toContain('image-fixture')
  expect(await listAntigravityModels(account)).toEqual(initial)
  expect(fetcher).toHaveBeenCalledTimes(1)
  now.mockReturnValue(400_000)
  expect(await listAntigravityModels(account)).toEqual(initial)
  expect(await listAntigravityModels(account)).toEqual(initial)
  expect(fetcher).toHaveBeenCalledTimes(2)
  __resetAntigravityModelsCache()
  pending.resolve(Response.json(catalog))
  await pending.promise
  fetcher.mockResolvedValue(Response.json({ models: {} }))
  expect((await listAntigravityModels(account)).map(model => model.id)).not.toContain('image-fixture')
})

it('retains a stale catalog through an authentication failure and recovers on the next refresh', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ models: {} }))
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockImplementation(async () => Response.json({ models: { recovered: {} }, imageGenerationModelIds: ['recovered'] }))
  vi.stubGlobal('fetch', fetcher)
  const initial = await listAntigravityModels(account)
  now.mockReturnValue(400_000)
  expect(await listAntigravityModels(account)).toEqual(initial)
  await vi.waitFor(async () => {
    expect((await listAntigravityModels(account)).map(model => model.id)).toContain('recovered')
  })
})

it('honors cancellation before reading native SSE and releases the body', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled before reading'))
  const cancelled = vi.fn(() => { throw new Error('cancel failure') })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled }), {
    headers: { 'content-type': 'text/event-stream' },
  })))
  await expect(callAntigravityGeminiNative({ account, model: 'gemini', action: 'generateContent', body: {}, signal: controller.signal }))
    .rejects.toThrow('cancelled before reading')
  expect(cancelled).toHaveBeenCalledOnce()
})

it('cancels an active native SSE read and tolerates a failing body cancellation', async () => {
  const controller = new AbortController()
  const reading = Promise.withResolvers<undefined>()
  const cancelled = vi.fn(() => { throw new Error('cancel failure') })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    pull() { reading.resolve(undefined) }, cancel: cancelled,
  }), { headers: { 'content-type': 'text/event-stream' } })))
  const response = callAntigravityGeminiNative({ account, model: 'gemini', action: 'generateContent', body: {}, signal: controller.signal })
  await reading.promise
  controller.abort(new Error('cancelled during read'))
  await expect(response).rejects.toThrow('cancelled during read')
  expect(cancelled).toHaveBeenCalledOnce()
})

it.each(['1536x1024', '1024x1536', '1792x1024', '1024x1792'])('projects image dimensions %s', async (size) => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('data: {"candidates":[{"content":{"parts":[{"inlineData":{"data":"aA=="}}]}}]}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })))
  expect((await callAntigravityImageGenerations({ account, body: { model: 'image', prompt: 'draw', size } })).status).toBe(200)
})

it.each([[], [{ text: 'no image' }], [{ inlineData: { data: 'AB==', mimeType: 'image/png' } }]].map(parts => [parts] as const))('refuses missing or invalid generated images %j', async (parts) => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts } }] })}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })))
  expect((await callAntigravityImageGenerations({ account, body: { model: 'image', prompt: 'draw' } })).status).toBe(502)
})

it.each(['chat', 'native'] as const)('returns %s upstream errors without response bodies', async (kind) => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  for (const response of [new Response(null, { status: 503 }), new Response(null), new Response('not SSE')]) {
    fetcher.mockResolvedValueOnce(response)
    const result = kind === 'chat'
      ? await callAntigravityChat({ account, body: { model: 'gemini', messages: [] } })
      : await callAntigravityGeminiNative({ account, body: {}, model: 'gemini', action: 'generateContent' })
    expect(result.status).toBe(response.status === 503 ? 503 : 502)
    expect(await result.json()).toHaveProperty('error.message')
  }
})

it('refuses native requests without a project', async () => {
  const response = await callAntigravityGeminiNative({ account: { token: { accessToken: 'fixture' } }, body: {}, model: 'gemini', action: 'generateContent' })
  expect(response.status).toBe(401)
})

it.each(['generateContent', 'streamGenerateContent'] as const)('sanitizes native upstream stream errors for %s', async (action) => {
  for (const error of [{ code: 429, message: 'secret' }, { message: 'secret' }]) {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(`data: ${JSON.stringify({ error })}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })))
    const response = await callAntigravityGeminiNative({ account, body: {}, model: 'gemini', action })
    const output = await response.text()
    expect(output).not.toContain('secret')
    expect(output).toContain('UPSTREAM_ERROR')
    expect(output).toContain('429' === String(error.code) ? '429' : action === 'generateContent' ? '500' : '502')
  }
})

it.each(['', 'data: null\n\n', 'data: "heartbeat"\n\n'])('refuses an empty native response %j', async (body) => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } })))
  const response = await callAntigravityGeminiNative({ account, body: {}, model: 'gemini', action: 'generateContent' })
  expect(response.status).toBe(502)
})

it('merges adjacent native text while retaining metadata and candidate order', async () => {
  const frames = [
    { candidates: [null, { index: 3, content: { role: 'model', parts: [{ text: 'first' }] } }] },
    { candidates: [{ index: 3, content: { parts: [{ text: ' second' }, { text: 'thought', thought: true }, null] } }, {}], usageMetadata: { totalTokenCount: 3 } },
  ]
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })))
  const response = await callAntigravityGeminiNative({ account, body: {}, model: 'gemini', action: 'generateContent' })
  expect(await response.json()).toMatchObject({ candidates: [
    { index: 3, content: { parts: [{ text: 'first second' }, { text: 'thought', thought: true }, null] } },
    { index: 1, content: { role: 'model', parts: [] } },
  ], usageMetadata: { totalTokenCount: 3 } })
})

it.each([
  [], 'invalid', { generationConfig: {}, generation_config: {} }, { contents: {} },
  { contents: [null] }, { contents: [{}] },
  ...[null, {}, { text: 'x', inlineData: {} }, { inlineData: {}, fileData: {} },
    { inlineData: null }, { inlineData: { data: '' } }, { inlineData: { data: 'aA==', mimeType: '' } },
    { fileData: null }, { fileData: {} }, { fileData: { fileUri: '' } },
    ...['A', 'AB==', 'ABC=', 'AA=', '====', '@@'].map(data => ({ inlineData: { mimeType: 'image/png', data } })),
  ].map(part => ({ contents: [{ parts: [part] }] })),
  { contents: [{ parts: [{ text: 'x' }] }], metadata: 1n },
])('rejects invalid native Gemini input %#', async (body) => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  const response = await callAntigravityGeminiNative({ account, model: 'gemini', action: 'generateContent', body })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { status: 'INVALID_ARGUMENT' } })
  expect(fetcher).not.toHaveBeenCalled()
})

it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])('rejects invalid native byte limit %s', async (limit) => {
  const response = await callAntigravityGeminiNative({ account, model: 'gemini', action: 'generateContent', body: {}, config: {
    native: { 'max-inline-media-bytes': limit },
  } })
  expect(response.status).toBe(400)
})

it('normalizes native tools and thinking options while retaining unknown fields', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('data: {"candidates":[{"finishReason":"STOP"}]}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }))
  vi.stubGlobal('fetch', fetcher)
  const response = await callAntigravityGeminiNative({ account, model: 'gemini', action: 'generateContent', body: {
    generation_config: { thinking_config: { thinking_budget: 100, include_thoughts: true } },
    tools: [null, {}, { function_declarations: [null, { name: 'no_parameters' }, { name: 'tool', parameters: { type: 'object', required: ['value'] } }] }],
  } })
  expect(response.status).toBe(200)
  const body = fetcher.mock.calls[0]?.[1]?.body
  if (typeof body !== 'string') throw new Error('expected JSON request')
  expect(JSON.parse(body)).toMatchObject({ request: {
    generationConfig: { thinkingConfig: { thinkingBudget: 100, includeThoughts: true } },
    tools: [null, {}, { functionDeclarations: [null, { name: 'no_parameters' }, { name: 'tool', parameters: { type: 'object', required: ['value'] } }] }],
  } })
})

it('keeps model discovery available without a project grant', async () => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  const models = await listAntigravityModels({ token: { accessToken: 'fixture' } })
  expect(models.map(model => model.id)).toEqual(expect.arrayContaining([...staticAntigravityTextModelIds()]))
  expect(fetcher).not.toHaveBeenCalled()
})

it.each([null, {}, { models: [] }, { models: { unknown: {} }, agentModelSorts: [null, {}, { groups: [null, {}, { modelIds: ['missing', 42] }] }] }])('falls back or filters malformed catalog %j', async (body) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)))
  const models = await listAntigravityModels(account)
  expect(models.length).toBeGreaterThan(0)
  expect(models.map(model => model.id)).not.toContain('unknown')
  expect(models.map(model => model.id)).not.toContain('missing')
})

it('exposes newly advertised agent models without exposing unlisted internal catalog keys', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    models: { 'claude-sonnet-5-5-high': {}, 'gemini-3.8-flash-high': {}, internal: {}, 'bad id': {}, disabled: { disabled: true } },
    defaultAgentModelId: 'claude-sonnet-5-5-high',
    agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash-high', 'claude-sonnet-5-5-high', 'missing', 'bad id', 'disabled'] }] }],
    imageGenerationModelIds: ['disabled'],
  })))
  const models = (await listAntigravityModels(account)).map(model => model.id)
  expect(models.filter(id => /5-5|3\.8|internal|missing|bad id|disabled/.test(id))).toMatchInlineSnapshot(`
    [
      "claude-sonnet-5-5-high",
      "gemini-3.8-flash-high",
    ]
  `)
})

it.each([401, 403, 500])('handles catalog HTTP %s without exposing upstream content', async (status) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const cancelled = vi.fn(() => { throw new Error('cancel failure') })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled }), { status })))
  const models = listAntigravityModels(account)
  if (status === 500) expect((await models).length).toBeGreaterThan(0)
  else await expect(models).rejects.toThrow(/Antigravity/)
  expect(cancelled).toHaveBeenCalledOnce()
})

it.each([
  new Error('network'), 'network', 42, false, undefined, null, {},
  { cause: { code: 42, message: false } }, { cause: { name: 'network' } }, { cause: {} },
])('falls back to the static catalog after transport failure %j', async (error) => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(error))
  expect((await listAntigravityModels(account)).length).toBeGreaterThan(0)
  expect(diagnostic).toHaveBeenCalledOnce()
})

it.each([
  null, {}, { model: 'image' }, { prompt: 'draw' }, { n: 0 }, { n: 5 }, { n: 1.5 },
  { response_format: 'other' }, { mask: 'mask' }, { images: Array.from({ length: 6 }, () => 'https://image.test/a') },
  { image: {} }, { image: { file_id: 'opaque' } }, { image: 'broken' }, { image: 'file:///tmp/image.png' },
  { image: { url: 'https://image.test/a', media_type: 'application/pdf' } },
])('rejects malformed image request %j before network access', async (patch) => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  const body = patch === null || Object.keys(patch).length === 0 || 'model' in patch || 'prompt' in patch
    ? patch : { model: 'image', prompt: 'draw', ...patch }
  expect((await callAntigravityImageGenerations({ account, body })).status).toBe(400)
  expect(fetcher).not.toHaveBeenCalled()
})

it.each([
  'https://image.test/a', { url: 'https://image.test/a', media_type: 'image/png' },
  { image_url: 'https://image.test/a', mime_type: 'image/jpeg' }, { image_url: { url: 'https://image.test/a' } },
  'data:image/png;base64,aA==',
])('projects image source %j and returns a generated data URL', async (image) => {
  const output = { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'aA==' } }] } }] }
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(`data: ${JSON.stringify(output)}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })))
  const response = await callAntigravityImageGenerations({ account, body: {
    model: 'image', prompt: 'draw', image, response_format: 'url', quality: 'high',
  } })
  expect(await response.json()).toMatchObject({ data: [{ url: 'data:image/png;base64,aA==', revised_prompt: 'draw' }] })
})

it.each([':heartbeat\nunknown\nevent\ndata: {"candidates":[{"finishReason":"STOP"}]}', '\uFEFFdata: {"candidates":[{"finishReason":"STOP"}]}\r\n\r\n'])('reads SSE fields and an unterminated final frame', async (body) => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } })))
  const response = await callAntigravityChat({ account, body: { model: 'gemini', messages: [] } })
  expect(await response.json()).toMatchObject({ choices: [{ finish_reason: 'stop' }] })
})
