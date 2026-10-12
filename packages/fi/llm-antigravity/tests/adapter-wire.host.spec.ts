/** Adapter projection validates transported SSE independently of upstream protocol conversion. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { AntigravityAdapter } from '../src/adapter.ts'
import { callAntigravityChat, listAntigravityModels } from '../src/transport.ts'
import { antigravityReplayEnvelope } from '../src/replay.ts'

vi.mock('../src/transport.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/transport.ts')>(),
  callAntigravityChat: vi.fn(), listAntigravityModels: vi.fn(),
}))
afterEach(() => { vi.resetAllMocks() })

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const request: GenerateOptions = { provider: 'antigravity', model: 'fixture', messages: [] }
const grant = async () => ({ accessToken: 'fixture', projectId: 'project' })
const delta = (value: object, finish_reason?: string) => ({
  choices: [{ delta: value, ...finish_reason === undefined ? {} : { finish_reason } }],
})
const image = (data = PNG, mediaType = 'image/png') => ({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } })
function response(events: readonly unknown[]): Response {
  return new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
async function collect(adapter: AntigravityAdapter, options = request): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}
async function attachments() {
  const root = await mkdtemp(join(tmpdir(), 'fi-adapter-wire-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return new LocalAttachmentStore(ctx, { dshHome: root })
}

it.each(['length', 'content_filter', 'stop', 'tool_calls'])('projects finish reason %s', async (reason) => {
  vi.mocked(callAntigravityChat).mockResolvedValue(response([delta({ content: 'answer' }, reason)]))
  const chunks = await collect(new AntigravityAdapter(grant))
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: { length: 'max-tokens', content_filter: 'error', stop: 'stop', tool_calls: 'tool-calls' }[reason] } })
})

it.each([null, [], 'not an object'])('rejects malformed transported event %j', async (value) => {
  vi.mocked(callAntigravityChat).mockResolvedValue(response([value]))
  expect((await collect(new AntigravityAdapter(grant))).at(-1))
    .toMatchObject({ type: 'finish', reason: { failure: { code: 'fi-antigravity/malformed-event' } } })
})

it.each([
  [{ antigravity_native_parts: {} }, 'invalid-signature'],
  [{ antigravity_native_parts: [null] }, 'invalid-signature'],
  [{ files: [{}] }, 'unsupported-content'],
  [{ images: {} }, 'invalid-image-output'],
  [{ images: [image()] }, 'invalid-image-output'],
  [{ antigravity_native_parts: [{ type: 'image', imageIndex: 0 }] }, 'invalid-image-output'],
] as const)('rejects unsupported delta %j', async (value, code) => {
  vi.mocked(callAntigravityChat).mockResolvedValue(response([delta(value)]))
  expect((await collect(new AntigravityAdapter(grant))).at(-1))
    .toMatchObject({ type: 'finish', reason: { failure: { code: `fi-antigravity/${code}` } } })
})

it.each([null, [], {}, { type: 'image_url', image_url: null }, { type: 'image_url', image_url: [] },
  { type: 'image_url', image_url: { url: 1 } }, { type: 'image_url', image_url: { url: 'https://image.test' } },
  image(''), image('A'), image('AB=='), image('ABC='), image('AA='), image('===='), image('AA==', 'image/unsupported'),
])('refuses malformed generated image %j before attachment admission', async (value) => {
  const store = await attachments()
  const save = vi.spyOn(store, 'saveImages')
  vi.mocked(callAntigravityChat).mockResolvedValue(response([delta({ images: [value], antigravity_native_parts: [{ type: 'image', imageIndex: 0 }] })]))
  const chunks = await collect(new AntigravityAdapter(grant, () => store))
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { failure: { code: 'fi-antigravity/invalid-image-output' } } })
  expect(save).not.toHaveBeenCalled()
})

it('merges split tool arguments and closes tools before text and reasoning', async () => {
  vi.mocked(callAntigravityChat).mockResolvedValue(response([
    delta({ content: '' }), delta({ reasoning_content: '' }),
    delta({ content: 'first' }), delta({ reasoning_content: 'think' }),
    delta({ tool_calls: [{ id: 'call-1', function: { name: 'tool', arguments: '{' } }, { id: 'call-2', function: { name: 'other', arguments: '{}' } }] }),
    delta({ tool_calls: [{ id: 'call-1', function: { arguments: '}' } }] }),
    delta({ content: 'after' }), delta({ reasoning_content: 'again' }),
    delta({ tool_calls: [{ function: {} }] }),
    delta({ reasoning_content: 'done' }),
    { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3 } } },
    { usage: {} }, delta({}, 'stop'),
  ]))
  const chunks = await collect(new AntigravityAdapter(grant))
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'block-end', block: { type: 'tool-call', id: 'call-1', name: 'tool', arguments: '{}' } }))
  expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 7, outputTokens: 2, totalTokens: 12, cacheReadTokens: 3 } })
  expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } })
})

it.each([false, true])('refuses conflicting tool signatures; native=%s', async (native) => {
  const call = (signature: string) => native
    ? delta({ antigravity_native_parts: [{ type: 'tool-call', id: 'tool', name: 'run', args: '{}', thoughtSignature: signature }] })
    : delta({ tool_calls: [{ id: 'tool', function: { name: 'run', arguments: '{}' }, extra_content: { google: { thought_signature: signature } } }] })
  vi.mocked(callAntigravityChat).mockResolvedValue(response([call('first'), call('second')]))
  expect((await collect(new AntigravityAdapter(grant))).at(-1))
    .toMatchObject({ type: 'finish', reason: { failure: { code: 'fi-antigravity/signature-conflict' } } })
})

it('refuses a non-string transported tool signature', async () => {
  const invalid = delta({ tool_calls: [{ extra_content: { google: { thought_signature: 1 } } }] })
  vi.mocked(callAntigravityChat).mockResolvedValue(response([invalid]))
  expect((await collect(new AntigravityAdapter(grant))).at(-1))
    .toMatchObject({ type: 'finish', reason: { failure: { code: 'fi-antigravity/signature-conflict' } } })
})

it('projects request controls and uses the static catalog after grant or discovery failures', async () => {
  expect((await new AntigravityAdapter(async () => { throw new Error('signed out') }).discoverModels('antigravity')).length).toBeGreaterThan(0)
  vi.mocked(listAntigravityModels).mockResolvedValue([])
  const adapter = new AntigravityAdapter(grant)
  expect((await adapter.discoverModels('antigravity')).length).toBeGreaterThan(0)
  vi.mocked(callAntigravityChat).mockResolvedValue(response([delta({}, 'stop')]))
  const signal = new AbortController().signal
  await collect(adapter, { ...request, signal, temperature: 0.5, maxTokens: 10, stop: ['stop'], tools: [] })
  expect(vi.mocked(callAntigravityChat).mock.calls[0]?.[0].signal).toBe(signal)
  expect(vi.mocked(callAntigravityChat).mock.calls[0]?.[0].body)
    .toMatchObject({ temperature: 0.5, max_tokens: 10, stop: ['stop'], tools: [] })
})

it('projects text roles, empty content, assistant images, and a tool result without images', async () => {
  const store = await attachments()
  const attachment = await store.saveImage({ data: Buffer.from(PNG, 'base64'), mediaType: 'image/png' })
  vi.mocked(callAntigravityChat).mockResolvedValue(response([delta({}, 'stop')]))
  await collect(new AntigravityAdapter(grant, () => store), { ...request, messages: [
    { id: 'system' as never, role: 'system', content: [{ type: 'text', text: 'system' }], source: { kind: 'system-prompt' } },
    { id: 'user' as never, role: 'user', content: [{ type: 'text', text: '' }], source: { kind: 'user' } },
    { id: 'assistant' as never, role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'reasoning', text: 'hidden' }], source: { kind: 'model', provider: 'other', model: 'fixture' } },
    { id: 'image' as never, role: 'assistant', content: [{ type: 'image', attachment }], source: { kind: 'model', provider: 'other', model: 'fixture' } },
    createToolResultMessage({ callId: 'call' as never, content: [{ type: 'text', text: 'tool result' }], isError: false }),
  ] })
  expect(vi.mocked(callAntigravityChat).mock.calls[0]?.[0].body).toMatchObject({ messages: [
    { role: 'system', content: 'system' }, { role: 'assistant', content: [{ type: 'image_url' }] },
    { role: 'tool', content: 'tool result' },
  ] })
})

it.each(['developer', 'user', 'assistant', 'system'] as const)('refuses unsupported %s content before dispatch', async (role) => {
  const content = role === 'developer' ? [{ type: 'text' as const, text: 'developer' }] : [{ type: 'reasoning' as const, text: 'unsupported' }]
  const message = role === 'assistant'
    ? { id: 'message' as never, role, content: [{ type: 'adapter-wire-extension' as const }], source: { kind: 'model' as const, provider: 'other', model: 'fixture' } }
    : { id: 'message' as never, role, content, source: { kind: 'system-prompt' as const } }
  await expect(collect(new AntigravityAdapter(grant), { ...request, messages: [message] })).rejects.toThrow('Antigravity cannot represent')
  expect(callAntigravityChat).not.toHaveBeenCalled()
})

it.each(['limit', 'short', 'long'] as const)('refuses signed replay originals with %s byte counts', async (kind) => {
  const store = await attachments()
  const data = Buffer.from(PNG, 'base64')
  const attachment = await store.saveImage({ data, mediaType: 'image/png' })
  const original = await store.saveFile({ data, name: 'original.png' })
  const bytes = kind === 'limit' ? store.imageLimits.maxImageBytes + 1 : kind === 'short' ? data.length + 1 : data.length - 1
  const replayState = antigravityReplayEnvelope('antigravity', 'fixture', [{ type: 'image' }], [{
    type: 'image', contentIndex: 0, thoughtSignature: 'signed', original: { attachment: { ...original, bytes }, mediaType: 'image/png' },
  }])
  vi.spyOn(store, 'readFileStream').mockImplementation(async function* () { yield data })
  await expect(collect(new AntigravityAdapter(grant, () => store), { ...request, messages: [{
    id: 'signed-image' as never, role: 'assistant', content: [{ type: 'image', attachment }],
    source: { kind: 'model', provider: 'antigravity', model: 'fixture', replayState },
  }] })).rejects.toThrow(kind === 'limit' ? 'image-byte limit' : 'durable byte count')
})

it('replays an unsigned assistant image through its admitted image bytes', async () => {
  const store = await attachments()
  const attachment = await store.saveImage({ data: Buffer.from(PNG, 'base64'), mediaType: 'image/png' })
  const replayState = antigravityReplayEnvelope('antigravity', 'fixture', [{ type: 'image' }], [{ type: 'image', contentIndex: 0 }])
  vi.mocked(callAntigravityChat).mockResolvedValue(response([delta({}, 'stop')]))
  await collect(new AntigravityAdapter(grant, () => store), { ...request, messages: [{
    id: 'image' as never, role: 'assistant', content: [{ type: 'image', attachment }],
    source: { kind: 'model', provider: 'antigravity', model: 'fixture', replayState },
  }] })
  expect(vi.mocked(callAntigravityChat).mock.calls[0]?.[0].body)
    .toMatchObject({ messages: [{ role: 'assistant', antigravity_native_parts: [{ type: 'image', mimeType: 'image/png' }] }] })
})

it('admits unsigned images and preserves their native order', async () => {
  const store = await attachments()
  vi.mocked(callAntigravityChat).mockResolvedValue(response([delta({
    images: [image()], antigravity_native_parts: [{ type: 'image', imageIndex: 0 }],
  }, 'stop')]))
  const chunks = await collect(new AntigravityAdapter(grant, () => store))
  expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({ type: 'block-end', block: { type: 'image' } })
})

it('retains abrupt end and malformed framing failures without leaking a reader lock', async () => {
  const body = new Response(': heartbeat\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"reasoning_content":"unfinished"}}]}\n\n').body!
  vi.mocked(callAntigravityChat).mockResolvedValue(new Response(body))
  expect((await collect(new AntigravityAdapter(grant))).at(-1)).toMatchObject({ type: 'finish', reason: { failure: { code: 'fi-antigravity/truncated' } } })
  expect(body.locked).toBe(false)
})

it('preserves cancellation when the response closes without a finish', async () => {
  const controller = new AbortController()
  const body = new ReadableStream<Uint8Array>({ start(stream) { controller.abort(); stream.close() } })
  vi.mocked(callAntigravityChat).mockResolvedValue(new Response(body))
  expect(await collect(new AntigravityAdapter(grant), { ...request, signal: controller.signal })).toEqual([])
  expect(body.locked).toBe(false)
})

it('preserves a terminal finish when reader cancellation fails', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[{"finish_reason":"stop"}]}\n\n')) },
    cancel() { throw new Error('cleanup failed') },
  })
  vi.mocked(callAntigravityChat).mockResolvedValue(new Response(body))
  expect((await collect(new AntigravityAdapter(grant))).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(body.locked).toBe(false)
})

it('keeps successive reasoning deltas in one block before tools and closes concurrent tools at finish', async () => {
  vi.mocked(callAntigravityChat).mockResolvedValue(response([
    delta({ reasoning_content: 'one' }), delta({ reasoning_content: 'two' }),
    delta({ tool_calls: [{ id: 'first', function: { name: 'first', arguments: '{}' } }, { id: 'second', function: { name: 'second', arguments: '{}' } }] }, 'tool_calls'),
  ]))
  const chunks = await collect(new AntigravityAdapter(grant))
  expect(chunks.filter(chunk => chunk.type === 'block-end')).toMatchObject([
    { block: { type: 'reasoning', text: 'onetwo' } }, { block: { id: 'first' } }, { block: { id: 'second' } },
  ])
})

it('requests image offload before a projected request exceeds the encoded byte bound', async () => {
  const store = await attachments()
  const attachment = await store.saveImage({ data: Buffer.from(PNG, 'base64'), mediaType: 'image/png' })
  const original = await store.readImageRequest(attachment, { width: 1, height: 1, maxBytes: store.imageLimits.maxImageBytes })
  vi.spyOn(store, 'readImageRequest').mockResolvedValue({ ...original, bytes: 20 * 1024 * 1024 })
  const message = { id: 'image' as never, role: 'user' as const, content: [{ type: 'image' as const, attachment }], source: { kind: 'user' as const } }
  await expect(collect(new AntigravityAdapter(grant, () => store), { ...request, messages: [message] }))
    .rejects.toThrow('more oldest occurrence(s) must be offloaded')
  expect(callAntigravityChat).not.toHaveBeenCalled()
})

it('projects offloaded image occurrences as text', async () => {
  const store = await attachments()
  const attachment = await store.saveImage({ data: Buffer.from(PNG, 'base64'), mediaType: 'image/png' })
  vi.mocked(callAntigravityChat).mockResolvedValue(response([delta({}, 'stop')]))
  await collect(new AntigravityAdapter(grant, () => store), { ...request, messages: [{
    id: 'images' as never, role: 'user', source: { kind: 'user' },
    content: [{ type: 'image', attachment, offloaded: true }, { type: 'image', attachment }],
  }] })
  const body = vi.mocked(callAntigravityChat).mock.calls[0]?.[0].body
  expect(JSON.stringify(body)).toContain('image omitted to fit request image limits')
})

it('replays signed tool calls without native parts', async () => {
  const replayState = antigravityReplayEnvelope('antigravity', 'fixture', [{ type: 'tool-call', thoughtSignature: 'signed' }])
  vi.mocked(callAntigravityChat).mockResolvedValue(response([delta({}, 'stop')]))
  await collect(new AntigravityAdapter(grant), { ...request, messages: [{
    id: 'tool' as never, role: 'assistant', content: [{ type: 'tool-call', id: 'call' as never, name: 'tool', arguments: '{}' }],
    source: { kind: 'model', provider: 'antigravity', model: 'fixture', replayState },
  }] })
  expect(vi.mocked(callAntigravityChat).mock.calls[0]?.[0].body).toMatchObject({ messages: [
    { tool_calls: [{ extra_content: { google: { thought_signature: 'signed' } } }] },
  ] })
})

it('preserves cancellation during generated image admission', async () => {
  const store = await attachments()
  const controller = new AbortController()
  vi.spyOn(store, 'saveImages').mockImplementation(async () => {
    controller.abort(new Error('cancelled'))
    throw controller.signal.reason
  })
  vi.mocked(callAntigravityChat).mockResolvedValue(response([delta({ images: [image()], antigravity_native_parts: [{ type: 'image', imageIndex: 0 }] })]))
  await expect(collect(new AntigravityAdapter(grant, () => store), { ...request, signal: controller.signal })).rejects.toThrow('cancelled')
})

it('uses empty arguments for a native tool call with null args', async () => {
  vi.mocked(callAntigravityChat).mockResolvedValue(response([delta({
    antigravity_native_parts: [{ type: 'tool-call', id: 'call', name: 'tool', args: null }],
  }, 'tool_calls')]))
  const chunks = await collect(new AntigravityAdapter(grant))
  expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({ block: { arguments: '{}' } })
})

it('closes streamed text before opening a tool call', async () => {
  vi.mocked(callAntigravityChat).mockResolvedValue(response([
    delta({ content: 'answer' }),
    delta({ tool_calls: [{ index: 0, id: 'call', function: { name: 'tool', arguments: '{}' } }] }, 'tool_calls'),
  ]))
  const chunks = await collect(new AntigravityAdapter(grant), { ...request, messages: [{
    id: 'previous' as never, role: 'assistant', content: [{ type: 'text', text: 'previous answer' }],
    source: { kind: 'model', provider: 'antigravity', model: 'fixture' },
  }] })
  expect(chunks.filter(chunk => chunk.type === 'block-end')).toMatchObject([
    { block: { type: 'text', text: 'answer' } }, { block: { type: 'tool-call', name: 'tool' } },
  ])
})

it('refuses an oversized unterminated SSE line', async () => {
  vi.mocked(callAntigravityChat).mockResolvedValue(new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024 * 1024 + 1).fill(32))
      controller.close()
    },
  })))
  const chunks = await collect(new AntigravityAdapter(grant))
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { failure: { code: 'fi-antigravity/frame-too-large' } } })
})

it('stores signed JPEG originals with a jpg filename', async () => {
  const jpeg = '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z'
  const store = await attachments()
  const saveFile = vi.spyOn(store, 'saveFile')
  vi.mocked(callAntigravityChat).mockResolvedValue(response([delta({
    images: [image(jpeg, 'image/jpeg')],
    antigravity_native_parts: [{ type: 'image', imageIndex: 0, thoughtSignature: 'signed' }],
  }, 'stop')]))
  const chunks = await collect(new AntigravityAdapter(grant, () => store))
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(saveFile.mock.calls[0]?.[0]).toMatchObject({ name: 'antigravity-generated.jpg', data: Uint8Array.from(Buffer.from(jpeg, 'base64')) })
})

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    /** Extension block the Antigravity wire format cannot project. */
    'adapter-wire-extension': { readonly type: 'adapter-wire-extension' }
  }
}
