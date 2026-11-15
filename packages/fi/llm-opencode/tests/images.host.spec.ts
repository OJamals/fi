import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import OpenCodeService, { OpenCodeAdapter, OPENCODE_KEY } from '../src/index.ts'
import type { ConsoleGrant, ConsoleOptions } from '../src/protocol.ts'
import { REGISTRY_URL } from '../src/registry.ts'

const config: ConsoleOptions = {
  server: 'https://opencode.ai/console', clientId: 'opencode-cli', userAgent: 'opencode/latest/2.2.5/cli',
  requestTimeoutMs: 5000, streamIdleTimeoutMs: 5000, refreshMarginMs: 120_000,
  catalogRetryCount: 0, catalogRetryDelayMs: 250, catalogCacheMs: 0, registryCacheMs: 300_000, registryStaleMs: 86_400_000,
  defaultContextWindow: 128_000, defaultMaxTokens: 8192,
}
const grant: ConsoleGrant = {
  type: 'oauth', server: config.server, access: 'test-access', refresh: 'test-refresh',
  expires: Date.now() + 3_600_000, email: 'test@example.test', accountId: 'test-account', orgId: 'org-z', orgName: 'Z',
}
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
)
const json = (value: unknown): Response => Response.json(value)
const stream = (body: string): Response => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
const data = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
const typed = (...events: { type: string; [field: string]: unknown }[]) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
const item = { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Seen', annotations: [] }] }
const replies: Record<string, () => Response> = {
  '@ai-sdk/openai-compatible': () => stream(data(
    { id: 'r', choices: [{ index: 0, delta: { content: 'Seen' }, finish_reason: null }] },
    { id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ) + 'data: [DONE]\n\n'),
  '@ai-sdk/openai': () => stream(data(
    { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: 'Seen' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
  )),
  '@ai-sdk/anthropic': () => stream(typed(
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'wire-model', content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Seen' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  )),
  '@ai-sdk/google': () => stream(data(
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Seen' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 } },
  )),
}
const catalog = (pkg: string, input: string[] | undefined) => ({
  providers: { opencode: { package: pkg, settings: { baseURL: 'https://opencode.ai/zen/v1' }, models: {
    friendly: { modelID: 'wire-model', name: 'Friendly', capabilities: { ...input === undefined ? {} : { input }, output: ['text'] } },
  } } },
})

/** Script the catalog and one inference reply; return the inference bodies. */
function serve(document: unknown, pkg: string): Record<string, unknown>[] {
  const captured: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === 'GET') return json(document)
    captured.push(z.record(z.string(), z.unknown()).parse(await request.json()))
    return replies[pkg]!()
  }))
  return captured
}

const imageMessage = (attachment: ImageAttachmentRef): GenerateOptions['messages'] => [{
  role: 'user', content: [{ type: 'text', text: 'Describe this.' }, { type: 'image', attachment }],
}]

async function run(adapter: OpenCodeAdapter, messages: GenerateOptions['messages']): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({ provider: 'opencode-console', model: 'friendly', messages })) chunks.push(chunk)
  return chunks
}

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function store(maxImageBytes?: number): Promise<{ attachments: LocalAttachmentStore; ref: ImageAttachmentRef }> {
  const dshHome = await mkdtemp(join(tmpdir(), 'fi-opencode-image-'))
  dirs.push(dshHome)
  const attachments = new LocalAttachmentStore(new Context(), { dshHome, ...maxImageBytes === undefined ? {} : { maxImageBytes } })
  const ref = await attachments.saveImage({ data: Uint8Array.from(PIXEL_PNG), mediaType: 'image/png', name: 'pixel.png' })
  return { attachments, ref }
}

function adapterWith(attachments: LocalAttachmentStore | undefined): OpenCodeAdapter {
  return new OpenCodeAdapter(() => config, async () => grant, undefined, undefined, {
    attachments: () => attachments, access: () => undefined,
  })
}

describe('OpenCode image input modalities', () => {
  it('advertises image input exactly where the Console catalog lists it', async () => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    serve(catalog('@ai-sdk/openai-compatible', ['text', 'image']), '@ai-sdk/openai-compatible')
    expect(await adapter.resolveModel('opencode-console', 'friendly')).toMatchObject({ inputModalities: ['text', 'image'] })
    expect(await adapter.discoverModels('opencode-console')).toMatchObject([{ id: 'friendly', inputModalities: ['text', 'image'] }])
    serve(catalog('@ai-sdk/openai-compatible', ['text']), '@ai-sdk/openai-compatible')
    expect(await adapter.resolveModel('opencode-console', 'friendly')).toMatchObject({ inputModalities: ['text'] })
    serve(catalog('@ai-sdk/openai-compatible', undefined), '@ai-sdk/openai-compatible')
    expect(await adapter.discoverModels('opencode-console')).toMatchObject([{ id: 'friendly', inputModalities: ['text'] }])
  })

  it('takes registry modalities unless the Console overrides them', async () => {
    const adapter = new OpenCodeAdapter(() => config, async () => grant)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Request(input).url === REGISTRY_URL
      ? json({ opencode: { npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/zen/v1', models: {
        seeing: { id: 'seeing', modalities: { input: ['text', 'image'], output: ['text'] } },
        blind: { id: 'blind', modalities: { input: ['text', 'image'], output: ['text'] } },
      } } })
      : json({ providers: { opencode: { models: { blind: { capabilities: { input: ['text'] } } } } } })))
    expect((await adapter.discoverModels('opencode-console')).map(model => [model.id, model.inputModalities])).toEqual([
      ['seeing', ['text', 'image']], ['blind', ['text']],
    ])
  })
})

describe('OpenCode image wire formats', () => {
  it('sends a chat-completions image as a data URL image_url part', async () => {
    const { attachments, ref } = await store()
    const captured = serve(catalog('@ai-sdk/openai-compatible', ['text', 'image']), '@ai-sdk/openai-compatible')
    expect((await run(adapterWith(attachments), imageMessage(ref))).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(JSON.stringify(captured[0]!['messages'])).toMatch(/"type":"image_url","image_url":\{"url":"data:image\/png;base64,[A-Za-z0-9+/=]+"/)
  })

  it('sends a Responses image as an input_image data URL', async () => {
    const { attachments, ref } = await store()
    const captured = serve(catalog('@ai-sdk/openai', ['text', 'image']), '@ai-sdk/openai')
    await run(adapterWith(attachments), imageMessage(ref))
    expect(JSON.stringify(captured[0]!['input'])).toMatch(/"type":"input_image"[^}]*"image_url":"data:image\/png;base64,[A-Za-z0-9+/=]+"/)
  })

  it('sends an Anthropic Messages image as a base64 source block', async () => {
    const { attachments, ref } = await store()
    const captured = serve(catalog('@ai-sdk/anthropic', ['text', 'image']), '@ai-sdk/anthropic')
    await run(adapterWith(attachments), imageMessage(ref))
    expect(JSON.stringify(captured[0]!['messages'])).toMatch(/"type":"image","source":\{"type":"base64","media_type":"image\/png","data":"[A-Za-z0-9+/=]+"\}/)
  })

  it('sends a Gemini image as inlineData', async () => {
    const { attachments, ref } = await store()
    const captured = serve(catalog('@ai-sdk/google', ['text', 'image']), '@ai-sdk/google')
    await run(adapterWith(attachments), imageMessage(ref))
    expect(JSON.stringify(captured[0]!['contents'])).toMatch(/"inlineData":\{"mimeType":"image\/png","data":"[A-Za-z0-9+/=]+"\}/)
  })
})

describe('OpenCode image admission', () => {
  it('refuses images for a text-only model before any inference request', async () => {
    const { attachments, ref } = await store()
    const captured = serve(catalog('@ai-sdk/openai-compatible', ['text']), '@ai-sdk/openai-compatible')
    await expect(run(adapterWith(attachments), imageMessage(ref))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT', message: 'OpenCode model "friendly" does not accept image input',
    })
    expect(captured).toEqual([])
  })

  it('refuses images without image services or a mounted attachment service', async () => {
    const { ref } = await store()
    serve(catalog('@ai-sdk/openai-compatible', ['text', 'image']), '@ai-sdk/openai-compatible')
    for (const adapter of [new OpenCodeAdapter(() => config, async () => grant), adapterWith(undefined)]) {
      await expect(run(adapter, imageMessage(ref))).rejects.toMatchObject({
        code: 'UNSUPPORTED_CONTENT', message: 'OpenCode image input requires the durable attachment service',
      })
    }
  })

  it('caps the request-image byte target at the OpenCode per-image limit', async () => {
    const { attachments, ref } = await store(64 * 1024 * 1024)
    const read = vi.spyOn(attachments, 'readImageRequest')
    serve(catalog('@ai-sdk/openai-compatible', ['text', 'image']), '@ai-sdk/openai-compatible')
    await run(adapterWith(attachments), imageMessage(ref))
    expect(read.mock.calls[0]![1]).toMatchObject({ maxBytes: 20 * 1024 * 1024 })
  })

  it('admits exactly 20 MiB and refuses larger images or types outside the shared set', async () => {
    const { attachments, ref } = await store()
    const read = vi.spyOn(attachments, 'readImageRequest')
    const captured = serve(catalog('@ai-sdk/anthropic', ['text', 'image']), '@ai-sdk/anthropic')
    const version = await attachments.readImageRequest(ref, { width: 1, height: 1, maxBytes: 1024 })
    read.mockResolvedValueOnce({ ...version, data: new Uint8Array(20 * 1024 * 1024 + 1) })
    await expect(run(adapterWith(attachments), imageMessage(ref))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT', message: `OpenCode image is ${20 * 1024 * 1024 + 1} bytes; OpenCode accepts at most ${20 * 1024 * 1024} bytes per image`,
    })
    read.mockResolvedValueOnce({ ...version, mediaType: 'image/heic' as never })
    await expect(run(adapterWith(attachments), imageMessage(ref))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT', message: 'OpenCode model "friendly" does not accept image/heic images; use JPEG, PNG, GIF, or WebP',
    })
    expect(captured).toEqual([])
    read.mockResolvedValueOnce({ ...version, data: new Uint8Array(20 * 1024 * 1024) })
    await run(adapterWith(attachments), imageMessage(ref))
    expect(captured).toHaveLength(1)
  })
})

describe('OpenCode image input through the plugin', () => {
  it('resolves images through the mounted attachment service', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fi-opencode-'))
    dirs.push(dir)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalAttachmentStore, { dshHome: dir })
    await ctx.credentials.modifyRecord(OPENCODE_KEY, async () => ({ kind: 'grant', payload: grant }))
    const attachments = ctx.get('attachments')!
    const ref = await attachments.saveImage({ data: Uint8Array.from(PIXEL_PNG), mediaType: 'image/png', name: 'pixel.png' })
    const captured = serve(catalog('@ai-sdk/openai-compatible', ['text', 'image']), '@ai-sdk/openai-compatible')
    await liveConfig(ctx, OpenCodeService, { providers: { 'opencode-console': {} } }, 'fi-opencode')
    expect(await ctx.llm.resolveModelInfo('opencode-console', 'friendly')).toMatchObject({ inputModalities: ['text', 'image'] })
    for await (const _chunk of ctx.llm.stream({ provider: 'opencode-console', model: 'friendly', messages: imageMessage(ref) })) { /* drain */ }
    expect(JSON.stringify(captured[0]!['messages'])).toContain('data:image/png;base64,')
  })
})
