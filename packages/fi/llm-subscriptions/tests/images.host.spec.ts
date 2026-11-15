/** Image input over the native subscription transports: wire formats, per-model gating, and upstream limits. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import SubscriptionService from '../src/index.ts'
import { SubscriptionAdapter } from '../src/adapter.ts'
import type { SubscriptionAttachments, SubscriptionImageAccess } from '../src/adapter.ts'
import { catalogModels } from '../src/catalog.ts'
import { callCopilot } from '../src/copilot.ts'
import { checkImageSet, checkRequestImages, inlineParts, omitUnsupportedImages, requestImageBudget, requestImageCount, requestImageRebudget, unsupportedImageText } from '../src/images.ts'
import { cursorRequest } from '../src/native/cursor-api.ts'
import { kiroRequest } from '../src/native/kiro-api.ts'
import { bytes, decodeProto, nested, str } from '../src/native/subscription-protobuf.ts'
import type { SubscriptionGrant, SubscriptionOptions } from '../src/protocol.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { checkpointFrame, collect, concat, cursorServer, mcpFrame, textFrame, turnEnded } from './harness.ts'

const MIB = 1024 * 1024
const options: SubscriptionOptions = {
  requestTimeoutMs: 2000,
  streamIdleTimeoutMs: 2000,
  authTimeoutMs: 2000,
  pollIntervalMs: 1,
  refreshMarginMs: 60_000,
  defaultContextWindow: 32768,
  defaultMaxTokens: 1024,
  kiroRegion: 'us-east-1',
  geminiProjectId: '',
  geminiClientId: 'client',
  geminiClientSecret: 'secret',
  geminiCallbackPort: 45289,
}
const grantOf = (provider: SubscriptionGrant['provider'], extra: Partial<SubscriptionGrant> = {}): SubscriptionGrant => ({
  provider, accessToken: `${provider}-token`, refreshToken: '', expiresAt: '2099-01-01T00:00:00.000Z', ...extra,
})
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const url = (mime: string, data = PIXEL) => ({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } })
const ref: ImageBlock['attachment'] = {
  attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 70, width: 1, height: 1, name: 'pixel.png',
}
const imageMessages: GenerateOptions['messages'] = [
  { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', attachment: ref }] },
]
/** A store whose request version of every image has the given type and claimed size. */
function store(mediaType = 'image/png', size?: number, data = Buffer.from(PIXEL, 'base64')): SubscriptionAttachments {
  return {
    imageHostPath: () => '/host/pixel.png',
    readImageRequest: (attachment: ImageBlock['attachment']) => Promise.resolve({
      variantId: `sha256:${'b'.repeat(64)}`, attachment, data: Uint8Array.from(data), mediaType,
      bytes: size ?? data.length, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: false,
    }),
  } as never
}
const access = (attachments: SubscriptionAttachments | undefined): SubscriptionImageAccess => ({
  attachments: () => attachments,
  access: () => () => ({ readonlyPath: '/sandbox/pixel.png' }),
})
function adapterFor(grant: SubscriptionGrant, images?: SubscriptionImageAccess) {
  const adapter = new SubscriptionAdapter(() => options, () => Promise.resolve(grant), () => undefined, images)
  onTestFinished(() => adapter.dispose())
  return adapter
}
function script(handler: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    seen.push(request.clone())
    return handler(request)
  }))
  return seen
}
const sse = (...events: unknown[]) => new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
const chat = (content: string) => sse({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
const copilotModels = { data: [
  { id: 'gpt-4.1', capabilities: { type: 'chat', supports: { vision: true } } },
  { id: 'o3', capabilities: { type: 'chat', supports: {} } },
  { id: 'gpt-4.1', capabilities: { type: 'chat' } },
  { id: 'unstated', capabilities: { type: 'chat' } },
] }
const geminiReply = () => new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'SEEN' }] }, finishReason: 'STOP' }] } })}\n\n`,
  { headers: { 'content-type': 'text/event-stream' } })
const failure = (chunks: StreamChunk[]) => {
  const last = chunks.at(-1)
  return last?.type === 'finish' && last.reason.kind === 'error' ? last.reason.failure.message : undefined
}
const contexts: Context[] = [], dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

it('splits inline image parts and enforces each upstream media type and size rule', () => {
  expect(inlineParts('cursor', null)).toEqual([])
  expect(inlineParts('cursor', 'hi')).toEqual([{ type: 'text', text: 'hi' }])
  expect(inlineParts('kiro', [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: 'data:IMAGE/JPG;base64,AAAA' }]))
    .toEqual([{ type: 'text', text: 'a' }, { type: 'image', image: { mimeType: 'image/jpg', data: 'AAAA', bytes: 3 } }])
  expect(() => inlineParts('cursor', [{ type: 'file', file: {} }])).toThrow('Cursor accepts text and inline image content only')
  expect(() => inlineParts('copilot', [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }]))
    .toThrow('Copilot accepts inline base64 images only')
  expect(() => inlineParts('gemini-cli', [url('image/gif')])).toThrow('Gemini CLI does not support image/gif images')
  expect(() => inlineParts('cursor', [url('image/heic')])).toThrow('Cursor does not support image/heic images')
  expect(inlineParts('gemini-cli', [url('image/heic')])).toHaveLength(1)
  const oversized = 'A'.repeat(Math.ceil((20 * MIB + 1) / 3) * 4)
  expect(() => inlineParts('kiro', [url('image/png', oversized)])).toThrow(`Kiro image exceeds the ${20 * MIB}-byte limit`)

  const image = (size: number) => ({ mimeType: 'image/png', data: '', bytes: size })
  const many = (count: number) => Array.from({ length: count }, () => image(1))
  expect(() => { checkImageSet('cursor', many(10)) }).not.toThrow()
  expect(() => { checkImageSet('cursor', many(11)) }).toThrow(`Cursor accepts at most 10 images and ${16 * MIB} bytes of image data per request`)
  expect(() => { checkImageSet('cursor', [image(16 * MIB), image(1)]) }).toThrow('Cursor accepts at most 10 images')
  expect(() => { checkImageSet('kiro', many(50)) }).not.toThrow()

  expect(requestImageBudget('cursor')).toBe(Math.floor(16 * MIB / 3) * 4)
  expect(requestImageBudget('gemini-cli')).toBe(20 * MIB - 4096)
  expect(requestImageBudget('kiro')).toBeUndefined()
  expect(requestImageBudget('copilot')).toBeUndefined()
  expect(requestImageBudget('cline')).toBeUndefined()
  expect(requestImageCount('cursor')).toBe(10)
  expect(requestImageCount('kiro')).toBeUndefined()
  expect(requestImageCount('cline')).toBeUndefined()
})

it('checks only the image parts of a forwarded request, and bounds the Code Assist request', () => {
  expect(checkRequestImages('copilot', {})).toBe(false)
  expect(checkRequestImages('copilot', { messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] },
  ] })).toBe(false)
  expect(checkRequestImages('copilot', { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, url('image/webp')] }] })).toBe(true)
  expect(() => checkRequestImages('copilot', { messages: [{ role: 'user', content: [{ type: 'image_url' }] }] })).toThrow()
  const long = { type: 'text', text: 'x'.repeat(20 * MIB) }
  expect(checkRequestImages('gemini-cli', { messages: [{ role: 'user', content: [long] }] })).toBe(false)
  expect(() => checkRequestImages('gemini-cli', { messages: [{ role: 'user', content: [url('image/png'), long] }] }))
    .toThrow(`Gemini CLI inline images exceed the ${20 * MIB}-byte request limit`)
})

it('sends Cursor images as selected_images, numbering them in a transcript', () => {
  const user = (body: unknown) => nested(nested(nested(nested(decodeProto(cursorRequest(body).subarray(5)), 1), 2), 1), 1)
  const selected = (fields: ReturnType<typeof user>) => (nested(fields, 3).get(1) ?? []).map((value) => {
    const image = decodeProto(Buffer.isBuffer(value) ? value : Buffer.alloc(0))
    return { mime: str(image, 7), data: bytes(image, 8).toString('base64'), uuid: /^[0-9a-f-]{36}$/.test(str(image, 2)) }
  })
  const single = user({ model: 'cursor/composer', messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, url('image/png')] },
  ] })
  expect(str(single, 1)).toBe('sys\n\nlook')
  expect(selected(single)).toEqual([{ mime: 'image/png', data: PIXEL, uuid: true }])
  const transcript = user({ model: 'cursor/composer', messages: [
    { role: 'user', content: [url('image/jpeg')] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'and' }, url('image/gif')] },
  ] })
  expect(str(transcript, 1)).toBe('user: [image 1]\n\nassistant: ok\n\nand\n[image 2]')
  expect(selected(transcript).map(image => image.mime)).toEqual(['image/jpeg', 'image/gif'])
  expect(() => cursorRequest({ model: 'cursor/composer', messages: [{ role: 'user', content: Array.from({ length: 11 }, () => url('image/png')) }] }))
    .toThrow('Cursor accepts at most 10 images')
})

it('sends Kiro images as ImageBlocks on user turns, including the turn that carries tool-result images', () => {
  const call = { id: 'call_1', function: { name: 'shot', arguments: '{}' } }
  const request = kiroRequest({ model: 'kiro/claude-sonnet-4.5', messages: [
    { role: 'user', content: [{ type: 'text', text: 'first' }, url('image/jpg')] },
    { role: 'user', content: [url('image/webp')] },
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', tool_call_id: 'call_1', content: '(see attached image)' },
    { role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, url('image/png')] },
  ] }, grantOf('kiro'))
  const block = (format: string) => ({ format, source: { bytes: PIXEL } })
  expect(request.conversationState.history[0]?.userInputMessage).toMatchObject({ content: 'first', images: [block('jpeg'), block('webp')] })
  expect(request.conversationState.currentMessage.userInputMessage).toMatchObject({
    content: 'Attached image(s) from tool result:',
    images: [block('png')],
    userInputMessageContext: { toolResults: [{ toolUseId: 'call_1', status: 'success' }] },
  })
  const pending = { role: 'assistant', content: '', tool_calls: [call] }
  for (const message of [
    { role: 'system', content: [url('image/png')] },
    { role: 'assistant', content: [url('image/png')] },
  ]) expect(() => kiroRequest({ model: 'kiro/auto', messages: [message, { role: 'user', content: 'hi' }] }, grantOf('kiro'))).toThrow('Kiro accepts images in user turns only')
  expect(() => kiroRequest({ model: 'kiro/auto', messages: [{ role: 'user', content: 'go' }, pending, { role: 'tool', tool_call_id: 'call_1', content: [url('image/png')] }] }, grantOf('kiro')))
    .toThrow('Kiro accepts images in user turns only')
})

it('marks Copilot image requests and refuses unsupported images before sending', async () => {
  const seen = script(() => chat('ok'))
  const grant = grantOf('copilot', { refreshToken: 'github-token' })
  const signal = AbortSignal.timeout(1000)
  await callCopilot(grant, { model: 'gpt-4.1', messages: [{ role: 'user', content: [url('image/png')] }] }, { initiator: 'user', signal })
  await callCopilot(grant, { model: 'gpt-4.1', messages: [{ role: 'user', content: 'hi' }] }, { initiator: 'user', signal })
  expect(seen.map(request => request.headers.get('copilot-vision-request'))).toEqual(['true', null])
  await expect(callCopilot(grant, { model: 'gpt-4.1', messages: [{ role: 'user', content: [url('image/heic')] }] }, { initiator: 'user', signal }))
    .rejects.toThrow('Copilot does not support image/heic images')
  expect(seen).toHaveLength(2)
})

it('reads image support from the Copilot and Kiro catalogs', async () => {
  script(() => Response.json(copilotModels))
  expect(await catalogModels(grantOf('copilot'), options)).toEqual([{ id: 'gpt-4.1', vision: true }, { id: 'o3', vision: false }, { id: 'unstated' }])
  script(() => Response.json({ models: [
    { modelId: 'claude-sonnet-4.5', supportedInputTypes: ['TEXT', 'IMAGE'] },
    { modelId: 'deepseek-3.2', supportedInputTypes: ['TEXT'] },
    { modelId: 'auto' },
    { modelId: 'odd', supportedInputTypes: 'IMAGE' },
    { modelId: 'claude-sonnet-4.5' },
  ] }))
  expect(await catalogModels(grantOf('kiro'), options)).toEqual([
    { id: 'claude-sonnet-4.5', vision: true }, { id: 'deepseek-3.2', vision: false }, { id: 'auto' }, { id: 'odd' },
  ])
  // An unexpected capability value on one row reads as unstated or unsupported instead of failing the catalog.
  script(() => Response.json({ data: [{ id: 'odd', capabilities: { type: 'chat', supports: null } }, { id: 'flag', capabilities: { type: 'chat', supports: { vision: 'yes' } } }] }))
  expect(await catalogModels(grantOf('copilot'), options)).toEqual([{ id: 'odd' }, { id: 'flag', vision: false }])
})

it('advertises image input per model and leaves catalog-dependent routes unknown without a catalog', async () => {
  script(() => Response.json(copilotModels))
  const copilot = adapterFor(grantOf('copilot'))
  expect((await copilot.discoverModels('copilot')).map(model => [model.id, model.inputModalities]))
    .toEqual([['gpt-4.1', ['text', 'image']], ['o3', ['text']], ['unstated', ['text', 'image']]])
  expect((await copilot.prepareCall('copilot', 'gpt-4.1')).model.inputModalities).toEqual(['text', 'image'])
  expect((await copilot.prepareCall('copilot', 'o3')).model.inputModalities).toEqual(['text'])
  expect((await copilot.prepareCall('copilot', 'unstated')).model.inputModalities).toEqual(['text', 'image'])
  expect((await copilot.resolveModel('copilot', 'gpt-4.1')).inputModalities).toBeUndefined()
  expect((await copilot.resolveModel('kiro', 'auto')).inputModalities).toBeUndefined()
  expect((await copilot.resolveModel('cursor', 'composer')).inputModalities).toEqual(['text', 'image'])
  expect((await copilot.resolveModel('gemini-cli', 'gemini-test')).inputModalities).toEqual(['text', 'image'])
  expect((await copilot.resolveModel('cline', 'cline-free/a')).inputModalities).toEqual(['text'])
})

it('streams a Copilot image with its handle text and refuses images the route cannot carry', async () => {
  const seen = script(request => request.url.endsWith('/models') ? Response.json(copilotModels) : chat('SEEN'))
  const grant = grantOf('copilot', { refreshToken: 'github-token' })
  const chunks = await collect(adapterFor(grant, access(store())).stream({ provider: 'copilot', model: 'gpt-4.1', messages: imageMessages }))
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'SEEN' }))
  const completion = seen.find(request => request.url.endsWith('/chat/completions'))
  expect(completion?.headers.get('copilot-vision-request')).toBe('true')
  const body = JSON.stringify(await completion?.json())
  expect(body).toContain(`data:image/png;base64,${PIXEL}`)
  expect(body).toContain('/sandbox/pixel.png')
  const run = (adapter: SubscriptionAdapter, model: string) => collect(adapter.stream({ provider: 'copilot', model, messages: imageMessages }))
  expect(await run(adapterFor(grant, access(store())), 'unstated')).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'SEEN' }))
  await expect(run(adapterFor(grant, access(store())), 'o3')).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT', message: 'Subscription model "o3" does not accept image input' })
  await expect(run(adapterFor(grant), 'gpt-4.1')).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT', message: 'Subscription image input requires the durable attachment service' })
  await expect(run(adapterFor(grant, access(undefined)), 'gpt-4.1')).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
})

it('applies the Code Assist image types and request bound before relaying', async () => {
  const seen = script(request => request.url.endsWith('retrieveUserQuota') ? Response.json({ buckets: [{ modelId: 'gemini-test' }] }) : geminiReply())
  const grant = grantOf('gemini-cli', { subscriptionAuth: { projectId: 'test-project' } })
  const run = (attachments: SubscriptionAttachments) =>
    collect(adapterFor(grant, access(attachments)).stream({ provider: 'gemini-cli', model: 'gemini-test', messages: imageMessages }))
  expect(await run(store())).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'SEEN' }))
  const relayed = seen.find(request => request.url.includes('streamGenerateContent'))
  expect(JSON.stringify(await relayed?.json())).toContain(`"inlineData":{"mimeType":"image/png","data":"${PIXEL}"}`)
  // A request image Code Assist does not accept becomes text instead of failing every later turn.
  expect(await run(store('image/gif'))).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'SEEN' }))
  const omitted = JSON.stringify(await seen.filter(request => request.url.includes('streamGenerateContent'))[1]?.json())
  expect(omitted).toContain('[image omitted: image/gif is not supported by Gemini CLI]')
  expect(omitted).not.toContain('inlineData')
  // Retained images past the request bound ask the runtime to offload the oldest instead of failing upstream.
  await expect(run(store('image/png', 16 * MIB))).rejects.toMatchObject({ code: 'IMAGE_OFFLOAD_REQUIRED' })
  expect(seen.filter(request => request.url.includes('streamGenerateContent'))).toHaveLength(2)
})

it('counts request text in the Code Assist image offload decision', async () => {
  const seen = script(request => request.url.endsWith('retrieveUserQuota') ? Response.json({ buckets: [{ modelId: 'gemini-test' }] }) : geminiReply())
  const grant = grantOf('gemini-cli', { subscriptionAuth: { projectId: 'test-project' } })
  const run = (text: string) => collect(adapterFor(grant, access(store())).stream({ provider: 'gemini-cli', model: 'gemini-test', messages: [
    { role: 'user', content: [{ type: 'text', text }, { type: 'image', attachment: ref }] },
  ] }))
  expect(await run('x'.repeat(19 * MIB))).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'SEEN' }))
  await expect(run('x'.repeat(20 * MIB - 32 * 1024))).rejects.toMatchObject({ code: 'IMAGE_OFFLOAD_REQUIRED', failure: { offloadImages: 1 } })
  expect(seen.filter(request => request.url.includes('streamGenerateContent'))).toHaveLength(1)
})

it('replaces only unsupported request images with text and measures only size-bounded routes', () => {
  expect(unsupportedImageText('gemini-cli', 'image/gif')).toBe('[image omitted: image/gif is not supported by Gemini CLI]')
  const image = (mimeType: string) => ({ type: 'image' as const, data: 'AAAA', mimeType })
  const context = { systemPrompt: 'sys', messages: [
    { role: 'user' as const, content: 'plain', timestamp: 0 },
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'a' }, image('image/GIF'), image('image/png')], timestamp: 0 },
    { role: 'toolResult' as const, toolCallId: 'call_1', toolName: 'shot', isError: false, content: [image('image/heic')], timestamp: 0 },
  ] }
  expect(omitUnsupportedImages('cline', context as never)).toBe(context)
  expect(omitUnsupportedImages('gemini-cli', context as never).messages.map(message => message.content)).toEqual([
    'plain',
    [{ type: 'text', text: 'a' }, { type: 'text', text: '[image omitted: image/GIF is not supported by Gemini CLI]' }, image('image/png')],
    [image('image/heic')],
  ])
  expect(omitUnsupportedImages('kiro', context as never).messages[2]?.content)
    .toEqual([{ type: 'text', text: '[image omitted: image/heic is not supported by Kiro]' }])
  const huge = { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x'.repeat(20 * MIB) }, image('image/png')], timestamp: 0 }] }
  expect(requestImageRebudget('cline', huge as never)).toBeUndefined()
  expect(requestImageRebudget('cursor', huge as never)).toBeUndefined()
  expect(requestImageRebudget('gemini-cli', { messages: [{ role: 'user', content: 'x'.repeat(20 * MIB), timestamp: 0 }] } as never)).toBeUndefined()
  expect(requestImageRebudget('gemini-cli', context as never)).toBeUndefined()
  expect(requestImageRebudget('gemini-cli', huge as never)).toBe(0)
  const big = { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'look' }, { ...image('image/png'), data: 'A'.repeat(20 * MIB) }], timestamp: 0 }] }
  expect(requestImageRebudget('gemini-cli', big as never))
    .toBe(20 * MIB - 4096 - 64 * 1024 - (Buffer.byteLength(JSON.stringify(big)) - 20 * MIB))
})

it('answers a genuine image limit violation with a readable 400 instead of relaying it', async () => {
  const seen = script(request => request.url.endsWith('/models') ? Response.json(copilotModels) : chat('SEEN'))
  const grant = grantOf('copilot', { refreshToken: 'github-token' })
  const oversized = store('image/png', undefined, Buffer.alloc(20 * MIB + 1))
  const chunks = await collect(adapterFor(grant, access(oversized)).stream({ provider: 'copilot', model: 'gpt-4.1', messages: imageMessages }))
  expect(failure(chunks)).toContain(`Copilot image exceeds the ${20 * MIB}-byte limit`)
  expect(seen.filter(request => request.url.endsWith('/chat/completions'))).toHaveLength(0)
})

it('resolves images through the mounted attachment and filesystem services', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fi-subscriptions-images-'))
  dirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(LlmRuntime)
  ctx.provide('attachments', store() as never)
  ctx.provide('fs', { processPathFromHostPath: (path: string) => path.replace('/host/', '/sandbox/') } as never)
  const grant = grantOf('gemini-cli', { subscriptionAuth: { projectId: 'test-project' } })
  await ctx.credentials.modifyRecord(credentialKey('fi-subscriptions', 'gemini-cli'), async () => ({ kind: 'grant', payload: grant }))
  const seen = script(request => request.url.endsWith('retrieveUserQuota') ? Response.json({ buckets: [{ modelId: 'gemini-test' }] }) : geminiReply())
  await liveConfig(ctx, SubscriptionService, { ...options, providers: { 'gemini-cli': {} } }, 'fi-subscriptions')
  expect(await ctx.llm.resolveModelInfo('gemini-cli', 'gemini-test')).toMatchObject({ inputModalities: ['text', 'image'] })
  expect(await ctx.llm.discoverModels('fi-subscriptions', { provider: 'gemini-cli' }))
    .toEqual([{ id: 'gemini-test', name: 'gemini-test', inputModalities: ['text', 'image'] }])
  const chunks = await collect(ctx.llm.stream({ provider: 'gemini-cli', model: 'gemini-test', messages: imageMessages }))
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'SEEN' }))
  const relayed = JSON.stringify(await seen.find(request => request.url.includes('streamGenerateContent'))?.json())
  expect(relayed).toContain('"mimeType":"image/png"')
  expect(relayed).toContain('/sandbox/pixel.png')
})

it('replays a Cursor tool result with images on a new Run, closes the abandoned one, and offloads past ten images', async () => {
  const runs: Buffer[] = []
  const h = await cursorServer((stream, data) => {
    const packet = decodeProto(data.subarray(5))
    if (!packet.has(1)) return
    runs.push(data)
    stream.write(runs.length === 1
      ? concat(mcpFrame(7, 'native', {}, 'screenshot'), checkpointFrame())
      : concat(textFrame('SEEN'), turnEnded({ input: 5, output: 1 })))
  }, { onStream: (stream, headers) => {
    if (!String(headers[':path']).endsWith('GetUsableModels')) return undefined
    stream.respond({ ':status': 200 })
    stream.end(Buffer.from('\n\u0009\n\u0007default'))
    return true
  } })
  const adapter = adapterFor(grantOf('cursor', { subscriptionAuth: { machineId: 'machine' } }), access(store()))
  const tools = [{ name: 'screenshot', description: 'Capture the screen', parameters: { type: 'object', properties: {} } }]
  const assembler = new BlockAssembler()
  const go: GenerateOptions['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'look' }] }]
  for await (const chunk of adapter.stream({ provider: 'cursor', model: 'default', messages: go, tools, maxTokens: 256 })) assembler.push(chunk)
  const assistant = assembler.message({ provider: 'cursor', model: 'default', replayState: assembler.replayState })
  const call = assistant.content.find(block => block.type === 'tool-call')
  if (call?.type !== 'tool-call') throw new Error('Cursor returned no tool call')
  const result = createToolResultMessage({ callId: call.id, isError: false, content: [{ type: 'image', attachment: ref }] })
  const second = await collect(adapter.stream({ provider: 'cursor', model: 'default', messages: [...go, assistant, result], tools, maxTokens: 256 }))
  expect(second).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'SEEN' }))
  expect(h.runs()).toBe(2)
  const user = nested(nested(nested(nested(decodeProto((runs[1] as Buffer).subarray(5)), 1), 2), 1), 1)
  expect(str(user, 1)).toContain('[image 1]')
  expect(nested(user, 3).get(1)).toHaveLength(1)
  await vi.waitFor(() => { expect(h.open()).toBe(0) })
  const eleven: GenerateOptions['messages'] = [{ role: 'user', content: Array.from({ length: 11 }, () => ({ type: 'image' as const, attachment: ref })) }]
  await expect(collect(adapter.stream({ provider: 'cursor', model: 'default', messages: eleven, maxTokens: 256 })))
    .rejects.toMatchObject({ code: 'IMAGE_OFFLOAD_REQUIRED', failure: { offloadImages: 1 } })
})
