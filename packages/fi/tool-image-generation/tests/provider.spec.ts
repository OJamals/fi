/** Native image admission validates wire bytes before storing an attachment. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callNativeImage, type NativeImageRequest, type NativeImageTransportOptions, type NativeImageTarget } from '../src/provider.ts'
import { sniffRasterMediaType } from '../src/raster.ts'

const native = vi.hoisted(() => ({ generate: vi.fn(), edit: vi.fn() }))
vi.mock('@fi/llm-antigravity/transport', () => ({
  callAntigravityImageGenerations: native.generate,
  callAntigravityImageEdits: native.edit,
}))

const png = Buffer.from('89504e470d0a1a0a', 'hex')
const payload = (extra: Record<string, unknown> = {}) => ({ data: [{ b64_json: png.toString('base64'), ...extra }] })
const token = `header.${Buffer.from(JSON.stringify({ sub: 'fixture',
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.signature`

function options(response: Response, overrides: Partial<NativeImageTransportOptions> = {}): NativeImageTransportOptions {
  return { timeoutMs: 1000, maxOutputBytes: 100, fetch: async () => response,
    resolveOAuth: async () => ({ source: 'OAuth', auth: { apiKey: token } }),
    resolveAntigravityGrant: async () => ({ accessToken: 'fixture', projectId: 'project' }), ...overrides }
}

function call(
  response: Response,
  overrides: Partial<NativeImageTransportOptions> = {},
  signal = new AbortController().signal,
  request: Partial<NativeImageRequest> = {},
) {
  return callNativeImage(options(response, overrides), { provider: 'grok', imageModel: 'image-model' },
    { prompt: 'image', references: [], count: 1, ...request }, signal)
}

afterEach(() => { vi.clearAllMocks() })

describe('native image responses', () => {
  it.each([null, [], {}, { data: [] }, { data: [null] }, { data: [{}] }, { data: [{ b64_json: '' }] },
    { data: [{ b64_json: '?' }] }, { data: [{ b64_json: 'Zh==' }] },
    payload({ mime_type: 'image/gif' }), payload({ media_type: 'image/jpeg' }),
  ])('refuses malformed image payload %j', async (body) => {
    await expect(call(Response.json(body))).rejects.toMatchObject({ code: 'IMAGE_INVALID_RESPONSE' })
  })

  it.each([new Response(null), new Response('{broken'), new Response(new Uint8Array([255]))])
  ('refuses absent, malformed JSON, or invalid UTF-8 bodies', async (response) => {
    await expect(call(response)).rejects.toMatchObject({ code: 'IMAGE_INVALID_RESPONSE' })
  })

  it.each([
    { bytes: Buffer.from('ffd8ff', 'hex'), mime: 'image/jpeg' },
    { bytes: Buffer.from('RIFF0000WEBP', 'ascii'), mime: 'image/webp' },
    { bytes: png, mime: 'image/png' },
  ])('accepts canonical $mime raster bytes with optional identifiers', async ({ bytes, mime }) => {
    await expect(call(Response.json({ data: [{ b64_json: bytes.toString('base64'), mime_type: mime, generation_id: 'id' }] })))
      .resolves.toMatchObject([{ mediaType: mime, generationId: 'id' }])
    expect(sniffRasterMediaType(Buffer.from('RIFF0000WAVE', 'ascii'))).toBeUndefined()
  })

  it.each([
    { bytes: Buffer.from('a'), max: 0 }, { bytes: Buffer.from('aa'), max: 1 }, { bytes: Buffer.from('aaa'), max: 2 },
  ])('rejects encoded and decoded output overruns %j', async ({ bytes, max }) => {
    await expect(call(Response.json({ data: [{ b64_json: bytes.toString('base64') }] }), { maxOutputBytes: max }))
      .rejects.toMatchObject({ code: 'IMAGE_OUTPUT_TOO_LARGE' })
  })

  it('cancels an oversized streamed body even when cancellation rejects', async () => {
    const cancel = vi.fn(() => { throw new Error('cancel failed') })
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 8)) }, cancel })
    await expect(call(new Response(body), { maxOutputBytes: 1 })).rejects.toMatchObject({ code: 'IMAGE_OUTPUT_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('preserves an HTTP error when body cancellation rejects', async () => {
    const response = new Response(new ReadableStream({ cancel() { throw new Error('cancel failed') } }), { status: 503 })
    await expect(call(response)).rejects.toMatchObject({ code: 'IMAGE_UPSTREAM_ERROR' })
  })

  it('preserves a body-stream failure and releases the errored reader', async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error('body failed')) } })
    await expect(call(new Response(body))).rejects.toThrow('body failed')
    expect(body.locked).toBe(false)
  })

  it('reports ambiguous transport failure without retrying', async () => {
    const fetch = vi.fn(async () => { throw new Error('connection lost') })
    await expect(call(new Response(null), { fetch })).rejects.toMatchObject({ code: 'IMAGE_REQUEST_AMBIGUOUS' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('cancels a pending response and releases its reader for a non-Error abort reason', async () => {
    const reached = Promise.withResolvers<undefined>()
    const body = new ReadableStream({ pull() { reached.resolve(undefined) }, cancel() { throw new Error('cancel failed') } })
    const controller = new AbortController()
    const reading = call(new Response(body), {}, controller.signal)
    const rejected = expect(reading).rejects.toThrow('image generation aborted')
    await reached.promise
    await vi.waitFor(() => { expect(body.locked).toBe(true) })
    controller.abort('stop')
    await rejected
    expect(body.locked).toBe(false)
  })
})

describe('native image requests', () => {
  it('projects ordered references into the Codex edits endpoint', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(payload()))
    await callNativeImage(options(new Response(null), { fetch }), { provider: 'codex', imageModel: 'image-model' },
      { prompt: 'edit', references: [{ mediaType: 'image/png', data: png }], count: 1 }, new AbortController().signal)
    expect(fetch.mock.calls[0]?.[0]).toEqual(expect.stringContaining('/codex/images/edits'))
    const body = fetch.mock.calls[0]?.[1]?.body
    if (typeof body !== 'string') throw new Error('expected JSON request body')
    expect(JSON.parse(body)).toMatchObject({
      images: [{ image_url: `data:image/png;base64,${png.toString('base64')}` }], n: 1,
    })
  })

  it.each([false, true])('dispatches Antigravity references=%s with the resolved grant', async (editing) => {
    const invoke = editing ? native.edit : native.generate
    invoke.mockResolvedValue(Response.json(payload()))
    const target: NativeImageTarget = { provider: 'antigravity', imageModel: 'image-model' }
    await callNativeImage(options(new Response(null), {
      resolveAntigravityGrant: async () => ({ accessToken: 'token', projectId: editing ? undefined : 'project' }),
    }), target, { prompt: 'image', references: editing ? [{ mediaType: 'image/png', data: png }] : [], count: 1 }, new AbortController().signal)
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ account: { token: {
      accessToken: 'token', ...editing ? {} : { antigravityProjectId: 'project' },
    } } })
  })

  it('refuses Antigravity generation while signed out', async () => {
    await expect(callNativeImage(options(new Response(null), { resolveAntigravityGrant: async () => undefined }),
      { provider: 'antigravity', imageModel: 'image-model' }, { prompt: 'image', references: [], count: 1 }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'IMAGE_SUBSCRIPTION_OAUTH_REQUIRED' })
    expect(native.generate).not.toHaveBeenCalled()
  })

  it('passes Antigravity size, quality, and count to the native transport and scales its response bound', async () => {
    native.edit.mockResolvedValue(Response.json({ data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }] }))
    const results = await callNativeImage(options(new Response(null)), { provider: 'antigravity', imageModel: 'image-model' },
      { prompt: 'edit', references: [{ mediaType: 'image/png', data: png }], size: '1024x1536', quality: 'high', count: 2 },
      new AbortController().signal)
    expect(results).toHaveLength(2)
    expect(native.edit.mock.calls[0]?.[0]).toMatchObject({
      body: { model: 'image-model', prompt: 'edit', n: 2, size: '1024x1536', quality: 'high' },
      config: { native: { 'max-inline-media-bytes': 100, 'max-response-bytes': 136 + 1024 * 1024 } },
    })
  })

  it('omits every output option field when the request carries none', async () => {
    native.generate.mockResolvedValue(Response.json(payload()))
    await callNativeImage(options(new Response(null)), { provider: 'antigravity', imageModel: 'image-model' },
      { prompt: 'image', references: [], count: 1 }, new AbortController().signal)
    expect(native.generate.mock.calls[0]?.[0]).toHaveProperty('body',{ model: 'image-model', prompt: 'image', n: 1, response_format: 'b64_json' })
  })

  it.each([{ size: '1024x1024' as const }, { quality: 'high' as const }])
  ('refuses a Grok edit option %j before resolving credentials', async (option) => {
    const resolveOAuth = vi.fn()
    await expect(callNativeImage(options(new Response(null), { resolveOAuth }), { provider: 'grok', imageModel: 'image-model' },
      { prompt: 'edit', references: [{ mediaType: 'image/png', data: png }], count: 1, ...option }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'IMAGE_INVALID_ARGUMENT' })
    expect(resolveOAuth).not.toHaveBeenCalled()
  })

  it.each(['1792x1024' as const, '1024x1792' as const])('refuses Codex size %s before resolving credentials', async (size) => {
    const resolveOAuth = vi.fn()
    await expect(callNativeImage(options(new Response(null), { resolveOAuth }), { provider: 'codex', imageModel: 'image-model' },
      { prompt: 'image', references: [], count: 1, size }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'IMAGE_INVALID_ARGUMENT' })
    expect(resolveOAuth).not.toHaveBeenCalled()
  })

  it('requires exactly the requested image count', async () => {
    await expect(call(Response.json(payload()), {}, undefined, { count: 2 }))
      .rejects.toThrow('image provider must return exactly 2 images')
  })

  it('bounds the decoded bytes of all returned images together', async () => {
    const two = Response.json({ data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }] })
    await expect(call(two, { maxOutputBytes: png.byteLength * 2 }, undefined, { count: 2 })).resolves.toHaveLength(2)
    const over = Response.json({ data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }] })
    await expect(call(over, { maxOutputBytes: png.byteLength * 2 - 1 }, undefined, { count: 2 }))
      .rejects.toMatchObject({ code: 'IMAGE_OUTPUT_TOO_LARGE' })
  })
})
