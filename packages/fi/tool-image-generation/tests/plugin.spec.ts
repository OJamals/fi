import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as imageGenerationPlugin from '../src/index.ts'
import { ImageToolOwner } from '../src/tool.ts'

const dirs: string[] = []
const contexts: Context[] = []
const FIXTURE_URL = new URL('../../../llm/llm-deepseek/tests/fixtures/red.png', import.meta.url)
const JPEG_BASE64 = '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z'

function config(defaultProvider: imageGenerationPlugin.ImageGenerationProvider = 'codex'): imageGenerationPlugin.Config {
  return {
    defaultProvider,
    targets: {
      codex: { imageModel: 'gpt-image-2' },
      grok: { imageModel: 'grok-imagine-image-2.0' },
      antigravity: { imageModel: 'gemini-3.1-flash-image' },
    },
  }
}

function oauthToken(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function credential(provider: 'codex' | 'grok'): {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
} {
  return {
    type: 'oauth',
    access: oauthToken(provider === 'codex'
      ? { 'https://api.openai.com/auth': { chatgpt_account_id: 'account-fixture' } }
      : { sub: 'user-fixture' }),
    refresh: 'refresh-fixture',
    expires: Date.now() + 60 * 60 * 1000,
  }
}

async function composition(
  config: imageGenerationPlugin.Config,
  signedIn = true,
  maxMessageImageBytes?: number,
  maxImageBytes?: number,
): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fi-image-generation-'))
  dirs.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, {
    dshHome: root,
    ...maxMessageImageBytes === undefined ? {} : { maxMessageImageBytes },
    ...maxImageBytes === undefined ? {} : { maxImageBytes },
  })
  await ctx.plugin(LocalCredentialProvider, { path: join(root, '.credentials.yaml'), watch: false })
  if (signedIn) {
    if (config.targets.codex !== undefined) {
      await credentialStoreFrom(ctx).modify('openai-codex', () => Promise.resolve(credential('codex')))
    }
    if (config.targets.grok !== undefined) {
      await credentialStoreFrom(ctx).modify('xai', () => Promise.resolve(credential('grok')))
    }
  }
  const loader = Object.create(Loader.prototype) as Loader
  const plugin = loader.unwrapExports(imageGenerationPlugin) as Parameters<Context['plugin']>[0]
  expect(plugin).toBe(imageGenerationPlugin)
  const fiber = await ctx.plugin(plugin, config)
  return { ctx, fiber, root }
}

async function fixtureBase64(): Promise<string> {
  return (await readFile(FIXTURE_URL)).toString('base64')
}

interface ImageToolTestValue {
  readonly operation: string
  readonly image: Record<string, unknown>
  readonly references: unknown[]
}

function imageToolValue(value: unknown): ImageToolTestValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected image_gen object value')
  }
  const record = value as Record<string, unknown>
  const image = record['image']
  const references = record['references']
  if (typeof record['operation'] !== 'string'
    || image === null || typeof image !== 'object' || Array.isArray(image)
    || !Array.isArray(references)) {
    throw new Error('expected image_gen result fields')
  }
  return { operation: record['operation'], image: image as Record<string, unknown>, references }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function requestJson(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('expected request JSON string')
  return JSON.parse(init.body)
}

function firstResultText(result: { content: readonly unknown[] }): string {
  const first = result.content[0]
  if (first === null || typeof first !== 'object' || !('type' in first) || !('text' in first)
    || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected first tool result block to be text')
  }
  return first.text
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  const disposals = await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  const failed = disposals.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed !== undefined) throw failed.reason
})

describe('image generation tool composition', () => {
  it('resolves image references relative to the calling agent working directory', async () => {
    const { ctx, root } = await composition(config())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('image-agent-cwd'), { provider: 'fixture', model: 'fixture' }, { cwd: root })
    await writeFile(join(root, 'reference.png'), await readFile(FIXTURE_URL))
    const encoded = await fixtureBase64()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ b64_json: encoded }] })))
    const resolve = vi.spyOn(ctx.fs, 'resolve')
    const result = await ctx.tools.execute({ agent, signal: new AbortController().signal,
      callId: ToolCallId('agent-image-reference'), name: 'image_gen', arguments: { prompt: 'edit', referenced_image_paths: ['reference.png'] } })
    expect(result.isError).toBe(false)
    expect(resolve).toHaveBeenCalledWith('reference.png', expect.objectContaining({ cwd: root }))
  })

  it.each(['per-image', 'aggregate'] as const)('rejects references beyond the %s limit before sending them', async (limit) => {
    const source = await readFile(FIXTURE_URL)
    const { ctx, root } = await composition(config(), true,
      limit === 'aggregate' ? source.byteLength : source.byteLength * 3,
      limit === 'per-image' ? source.byteLength - 1 : source.byteLength)
    await writeFile(join(root, 'input.png'), source)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('image-reference-limit'), name: 'image_gen',
      arguments: { prompt: 'edit', referenced_image_paths: limit === 'aggregate' ? ['input.png', 'input.png'] : ['input.png'] } })
    expect(result.error?.info).toMatchObject({ code: 'IMAGE_REFERENCE_INVALID' })
    expect(firstResultText(result)).toContain(limit === 'aggregate' ? 'aggregate' : 'per-image')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a requested provider that has no configured image target', async () => {
    const { ctx } = await composition({ defaultProvider: 'codex', targets: { codex: { imageModel: 'fixture' } } })
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('image-missing-target'), name: 'image_gen', arguments: { prompt: 'image', provider: 'grok' } })
    expect(result.isError).toBe(true)
    expect(firstResultText(result)).toContain('must be one of ["codex"]')
  })

  it('retains optional attachment dimensions and accepts WebP output', async () => {
    const { ctx } = await composition(config())
    const encoded = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ b64_json: encoded }] })))
    const save = ctx.attachments.saveImage.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'saveImage').mockImplementation(async (input) => {
      const { name: _name, ...ref } = await save(input)
      return { ...ref, originalDimensions: { width: 2, height: 2 } }
    })
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('webp-image'), name: 'image_gen', arguments: { prompt: 'image' } })
    expect(result.isError).toBe(false)
    expect(imageToolValue(result.value).image).toMatchObject({ mediaType: 'image/webp', originalDimensions: { width: 2, height: 2 } })
    expect(imageToolValue(result.value).image).not.toHaveProperty('name')
  })

  it.each([
    { prompt: '   ' },
    { prompt: 'edit', referenced_image_paths: [] },
    { prompt: 'edit', referenced_image_paths: ['   '] },
    { prompt: 'edit', referenced_image_paths: ['missing.png'] },
    { prompt: 'edit', referenced_image_paths: ['.'] },
    { prompt: 'edit', referenced_image_paths: ['invalid.png'] },
  ])('rejects invalid model arguments or filesystem references %#', async (arguments_) => {
    const { ctx, root } = await composition(config())
    await writeFile(join(root, 'invalid.png'), 'not a raster')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('invalid-image-input'), name: 'image_gen', arguments: arguments_ })
    expect(result.isError).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves filesystem read failures', async () => {
    const { ctx, root } = await composition(config())
    await writeFile(join(root, 'input.png'), await readFile(FIXTURE_URL))
    vi.spyOn(ctx.fs, 'readBytes').mockRejectedValue(new Error('read failed'))
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('failed-image-read'), name: 'image_gen',
      arguments: { prompt: 'edit', referenced_image_paths: ['input.png'] } })
    expect(result.isError).toBe(true)
    expect(firstResultText(result)).toContain('read failed')
  })

  it('makes owner disposal idempotent and refuses calls from a retained registration', async () => {
    const { ctx, fiber } = await composition(config())
    await fiber.dispose()
    const owner = new ImageToolOwner(ctx, { defaultProvider: 'codex', targets: new Map([['codex', { imageModel: 'fixture' }]]),
      timeoutMs: 1000, maxOutputBytes: 1000, resolveOAuth: async () => undefined, resolveAntigravityGrant: async () => undefined })
    owner.register()
    await owner.dispose()
    await owner.dispose()
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('closed-image-owner'), name: 'image_gen', arguments: { prompt: 'image' } })
    expect(result.error?.info).toMatchObject({ code: 'IMAGE_ABORTED' })
  })

  it('classifies its own operation timeout after the request settles', async () => {
    const timed = config()
    timed.timeoutMs = 100
    const { ctx } = await composition(timed)
    vi.useFakeTimers()
    const reached = Promise.withResolvers<undefined>()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
      reached.resolve(undefined)
    })))
    const running = ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('timed-out-image'), name: 'image_gen', arguments: { prompt: 'image' } })
    await reached.promise
    await vi.advanceTimersByTimeAsync(100)
    const result = await running
    expect(result.error?.info).toMatchObject({ code: 'IMAGE_TIMEOUT' })
  })

  it('resolves Antigravity grants through the plugin credential store', async () => {
    const { ctx } = await composition(config('antigravity'), false)
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('unsigned-antigravity-image'), name: 'image_gen', arguments: { prompt: 'image' } })
    expect(result.error?.info).toMatchObject({ code: 'IMAGE_SUBSCRIPTION_OAUTH_REQUIRED' })
  })

  it('loads through the real Loader and returns the owner-local durable ImageBlock golden', async () => {
    const encoded = await fixtureBase64()
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestUrl(input)).toBe('https://chatgpt.com/backend-api/codex/images/generations')
      expect(init?.redirect).toBe('error')
      const body = requestJson(init)
      expect(body).toEqual({ model: 'gpt-image-2', prompt: 'draw a red pixel', n: 1 })
      return new Response(JSON.stringify({ data: [{ b64_json: encoded, generation_id: 'generation-fixture' }] }), {
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetch)
    const { ctx } = await composition(config())

    expect(ctx.tools.schemas().find(schema => schema.name === 'image_gen')).toMatchObject({
      name: 'image_gen',
      parameters: {
        properties: {
          prompt: { type: 'string' },
          provider: { type: 'string', enum: ['codex', 'grok', 'antigravity'] },
          referenced_image_paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['prompt'],
      },
    })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('image-generation-golden'),
      name: 'image_gen',
      arguments: { prompt: 'draw a red pixel' },
    })
    const expected: unknown = JSON.parse(await readFile(new URL('./expected/image-result.json', import.meta.url), 'utf8'))

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('image_gen unexpectedly failed')
    const value = imageToolValue(result.value)
    expect(result.value).toEqual(expected)
    expect(result.meta).toBeUndefined()
    expect(result.content).toEqual([
      { type: 'text', text: 'Generated one image with codex model gpt-image-2.' },
      { type: 'image', attachment: value.image },
    ])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('reads ordered references through ctx.fs, persists them, and sends the exact Grok edit body', async () => {
    const encoded = await fixtureBase64()
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestUrl(input)).toBe('https://api.x.ai/v1/images/edits')
      const body = requestJson(init) as {
        model: string
        prompt: string
        images: Array<{ type: string; url: string }>
        response_format: string
      }
      expect(body).toMatchObject({
        model: 'grok-imagine-image-2.0',
        prompt: 'make both blue',
        response_format: 'b64_json',
      })
      expect(body.images).toHaveLength(2)
      expect(body.images.every(image => image.type === 'image_url' && image.url.startsWith('data:image/png;base64,'))).toBe(true)
      return new Response(JSON.stringify({ data: [{ b64_json: encoded }] }), {
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetch)
    const { ctx, root } = await composition(config())
    const source = await readFile(FIXTURE_URL)
    await writeFile(join(root, 'one.png'), source)
    await writeFile(join(root, 'two.png'), source)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('image-edit'),
      name: 'image_gen',
      arguments: { prompt: 'make both blue', provider: 'grok', referenced_image_paths: ['one.png', 'two.png'] },
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('image_gen unexpectedly failed')
    const value = imageToolValue(result.value)
    expect(value.operation).toBe('edit')
    expect(value.references).toHaveLength(2)
    expect(result.content[1]).toEqual({ type: 'image', attachment: value.image })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('detects a Grok JPEG output from verified bytes and preserves its extension', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: JPEG_BASE64 }],
    }))))
    const { ctx } = await composition(config())

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('jpeg-output'),
      name: 'image_gen',
      arguments: { prompt: 'draw a jpeg', provider: 'grok' },
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('image_gen unexpectedly failed')
    expect(imageToolValue(result.value).image).toMatchObject({ mediaType: 'image/jpeg', name: 'generated-image.jpg' })
  })

  it.each([
    [{ data: [{ b64_json: 'bm90IGFuIGltYWdl' }] }, /invalid or unsupported raster bytes/],
    [{ data: [{ b64_json: JPEG_BASE64, mime_type: 'image/png' }] }, /media type did not match/],
    [{ data: [{ b64_json: JPEG_BASE64 }, { b64_json: JPEG_BASE64 }] }, /exactly one image/],
  ])('rejects unsafe provider image responses %#', async (wire, message) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(wire))))
    const { ctx } = await composition(config())

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('unsafe-image-output'),
      name: 'image_gen',
      arguments: { prompt: 'draw a circle' },
    })

    expect(result.isError).toBe(true)
    expect(firstResultText(result)).toMatch(message)
  })

  it('bounds aggregate reference bytes before reading every image', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { ctx, root } = await composition(config(), true, 100)
    const source = await readFile(FIXTURE_URL)
    await writeFile(join(root, 'one.png'), source)
    await writeFile(join(root, 'two.png'), source)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('aggregate-reference-limit'),
      name: 'image_gen',
      arguments: { prompt: 'edit both', referenced_image_paths: ['one.png', 'two.png'] },
    })

    expect(result.isError).toBe(true)
    expect(firstResultText(result)).toContain('aggregate message image byte limit')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects four Antigravity references before filesystem, credential, or network access', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { ctx } = await composition(config(), false)
    const resolve = vi.spyOn(ctx.fs, 'resolve')

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('antigravity-reference-limit'),
      name: 'image_gen',
      arguments: {
        prompt: 'edit these images',
        provider: 'antigravity',
        referenced_image_paths: ['one.png', 'two.png', 'three.png', 'four.png'],
      },
    })

    expect(result.isError).toBe(true)
    expect(firstResultText(result)).toContain('at most 3 reference images')
    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('starts unsigned, rejects non-OAuth execution, and performs no network request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { ctx } = await composition(config('grok'), false)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('unsigned-image-generation'),
      name: 'image_gen',
      arguments: { prompt: 'draw a circle' },
    })

    expect(result.isError).toBe(true)
    expect(firstResultText(result)).toContain('stored OAuth grant')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not retry an ambiguous upstream failure and preserves its HTTP status', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const { ctx } = await composition(config())

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('failed-image-generation'),
      name: 'image_gen',
      arguments: { prompt: 'draw a circle' },
    })

    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ code: 'IMAGE_UPSTREAM_ERROR' })
    expect(firstResultText(result)).toContain('HTTP 503')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('aborts and awaits an active request before HMR disposal completes', async () => {
    let fetchSettled = false
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          queueMicrotask(() => {
            fetchSettled = true
            reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'))
          })
        }, { once: true })
      })))
    const { ctx, fiber } = await composition(config())
    const running = ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('disposed-image-generation'),
      name: 'image_gen',
      arguments: { prompt: 'draw a circle' },
    })
    await vi.waitFor(() => { expect(globalThis.fetch).toHaveBeenCalledOnce() })

    await fiber.dispose()

    expect(fetchSettled).toBe(true)
    await expect(running).resolves.toMatchObject({ isError: true })
    expect(ctx.tools.schemas().some(schema => schema.name === 'image_gen')).toBe(false)
  })

  it('classifies cancellation during response streaming as an abort, not invalid JSON', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"data":['))
      },
      cancel() {},
    }))))
    const { ctx } = await composition(config())
    const running = ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('stream-abort'),
      name: 'image_gen',
      arguments: { prompt: 'draw a circle' },
    })
    await vi.waitFor(() => { expect(globalThis.fetch).toHaveBeenCalledOnce() })

    controller.abort(new Error('caller cancelled'))
    const result = await running

    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ code: 'IMAGE_ABORTED' })
  })

  it('does not publish success when cancellation arrives during output persistence', async () => {
    const encoded = await fixtureBase64()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: encoded }] }))))
    const { ctx } = await composition(config())
    const controller = new AbortController()
    const save = ctx.attachments.saveImage.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'saveImage').mockImplementation(async (input) => {
      const ref = await save(input)
      controller.abort(new Error('cancelled while persisting'))
      return ref
    })

    const result = await ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('persist-abort'),
      name: 'image_gen',
      arguments: { prompt: 'draw a circle' },
    })

    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ code: 'IMAGE_ABORTED' })
  })

  it('parks under the real Loader until the required credential service is in scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fi-image-credentials-'))
    dirs.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(LocalAttachmentStore, { dshHome: root })
    const loader = Object.create(Loader.prototype) as Loader
    const plugin = loader.unwrapExports(imageGenerationPlugin) as Parameters<Context['plugin']>[0]
    await ctx.plugin(plugin, config())

    expect(ctx.tools.schemas().some(schema => schema.name === 'image_gen')).toBe(false)
    await ctx.plugin(LocalCredentialProvider, { path: join(root, '.credentials.yaml'), watch: false })
    await vi.waitFor(() => { expect(ctx.tools.schemas().some(schema => schema.name === 'image_gen')).toBe(true) })
  })

  it.each([
    [{ targets: { codex: { imageModel: 'gpt-image-2' } } }, /defaultProvider/],
    [{ defaultProvider: 'codex', targets: {} }, /at least one/],
    [{ defaultProvider: 'codex', targets: { other: { imageModel: 'unknown' } } }, /unsupported target/],
    [{ defaultProvider: 'grok', targets: { codex: { imageModel: 'gpt-image-2' } } }, /configured target/],
    [{ defaultProvider: 'codex', targets: { codex: { imageModel: '   ' } } }, /imageModel/],
    [{ defaultProvider: 'codex', targets: config().targets, timeoutMs: 0 }, /timeoutMs/],
    [{ defaultProvider: 'codex', targets: config().targets, maxOutputBytes: 0 }, /maxOutputBytes/],
  ])('rejects invalid explicit config %#', async (config, message) => {
    const root = await mkdtemp(join(tmpdir(), 'fi-image-config-'))
    dirs.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(LocalAttachmentStore, { dshHome: root })
    await ctx.plugin(LocalCredentialProvider, { path: join(root, '.credentials.yaml'), watch: false })
    await expect(ctx.plugin(imageGenerationPlugin, config as imageGenerationPlugin.Config)).rejects.toThrow(message)
  })
})
