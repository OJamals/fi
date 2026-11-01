import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  apply, createLiveModelCaches, fetchLiveModels, HARNESS_ATTRIBUTION_HEADER, preserveHarnessHeaders,
  subscriptionFetch, subscriptionHeaders, subscriptionWebSocket, subscriptionWebSocketConnector,
} from '../src/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

function token(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

const codex = token({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })
const grok = token({ sub: 'user' })

describe('subscription request validation', () => {
  it.each([null, [], 'text', 42, {}, { sub: '' }])('rejects unusable Grok JWT payload %j', (payload) => {
    expect(() => subscriptionHeaders('xai', 'grok', 'session', 1000, {
      Authorization: `Bearer ${token(payload)}`,
    })).toThrow(/JWT payload|lacks a subject/)
  })

  it.each([
    ['invalid JSON', 'header.!.signature'],
    ['oversized encoding', `header.${'a'.repeat(140_000)}.signature`],
    ['oversized payload', `header.${Buffer.alloc(65_537, 32).toString('base64url')}.signature`],
  ])('rejects JWT with %s', (_label, value) => {
    expect(() => subscriptionHeaders('xai', 'grok', 'session', 1000, {
      Authorization: `Bearer ${value}`,
    })).toThrow('JWT payload')
  })

  it.each([null, 'account', {}, { chatgpt_account_id: 42 }])('rejects missing Codex account identity %j', (account) => {
    expect(() => subscriptionHeaders('openai-codex', 'gpt', 'session', 1000, {
      Authorization: `Bearer ${token({ 'https://api.openai.com/auth': account })}`,
    })).toThrow('lacks a ChatGPT account id')
  })

  it('rejects invalid request metadata and non-OAuth Claude authorization', () => {
    expect(() => subscriptionHeaders('anthropic', 'claude', '', 1000)).toThrow('sessionId')
    expect(() => subscriptionHeaders('anthropic', 'claude', 's', 0)).toThrow('timeoutMs')
    expect(() => subscriptionHeaders('anthropic', 'claude', 's', Infinity)).toThrow('timeoutMs')
    expect(() => subscriptionHeaders('anthropic', 'claude', 's', 1000, {
      Authorization: 'Bearer api-key',
    })).toThrow('Claude OAuth token')
  })

  it('retains explicit Harness attribution and nullable SDK headers', () => {
    const input = { 'User-Agent': 'sdk', [HARNESS_ATTRIBUTION_HEADER]: 'harness', 'x-disabled': null }
    expect(preserveHarnessHeaders(input)).toEqual(input)
    expect(preserveHarnessHeaders({ 'User-Agent': 'harness', 'x-disabled': null })).toEqual({
      'User-Agent': 'harness', [HARNESS_ATTRIBUTION_HEADER]: 'harness', 'x-disabled': null,
    })
    expect(preserveHarnessHeaders({ 'x-disabled': null })).toEqual({ 'x-disabled': null })
  })

  it.each([
    ['darwin', 'arm64', 'macos', 'MacOS', 'arm64', 'arm64', 'aarch64'],
    ['win32', 'x64', 'windows', 'Windows', 'x64', 'x86_64', 'x86_64'],
    ['freebsd', 'ia32', 'linux', 'FreeBSD', 'x86', 'ia32', 'x86_64'],
    ['linux', 'x64', 'linux', 'Linux', 'x64', 'x86_64', 'x86_64'],
  ])('uses %s/%s platform metadata', (platform, arch, grokOs, sdkOs, sdkArch, codexArch, grokArch) => {
    vi.stubGlobal('process', { ...process, platform, arch })
    expect(subscriptionHeaders('openai-codex', 'model', 's', 1, { Authorization: `Bearer ${codex}` })['User-Agent'])
      .toMatch(new RegExp(`^codex_cli_rs/\\S+ \\(.+; ${codexArch}\\) \\S+$`))
    expect(subscriptionHeaders('xai', 'model', 's', 1, { Authorization: `Bearer ${grok}` })['User-Agent'])
      .toContain(`(${grokOs}; ${grokArch})`)
    const headers = subscriptionHeaders('anthropic', 'claude', 's', 1, { Authorization: 'Bearer sk-ant-oat-test' })
    expect(headers['X-Stainless-Os']).toBe(sdkOs)
    expect(headers['X-Stainless-Arch']).toBe(sdkArch)
    expect(headers['X-Stainless-Timeout']).toBe('1')
  })
})

describe('live discovery failure handling', () => {
  it('contains cancellation failure while rejecting an oversized discovery stream', async () => {
    const cancel = vi.fn(() => { throw new Error('socket closed during cancellation') })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1048577)) },
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stream)))
    expect(await fetchLiveModels({ provider: 'xai', apiKey: grok }, createLiveModelCaches(1000))).toEqual([])
    expect(cancel).toHaveBeenCalledOnce()
    expect(stream.locked).toBe(false)
  })

  it.each(['openai-codex', 'xai'] as const)('ignores invalid %s replies without caching failure', async (provider) => {
    const responses = [
      new Response(null, { status: 304 }),
      new Response('{}'),
      new Response('invalid'),
      new Response('too large', { headers: { 'content-length': '1048577' } }),
      new Response(new Uint8Array(1048577)),
    ]
    const fetch = vi.fn<typeof globalThis.fetch>()
    for (const response of responses) fetch.mockResolvedValueOnce(response)
    vi.stubGlobal('fetch', fetch)
    const caches = createLiveModelCaches(1000)
    for (const _response of responses) {
      expect(await fetchLiveModels({ provider, apiKey: provider === 'xai' ? grok : codex,
        signal: new AbortController().signal }, caches)).toEqual([])
    }
    expect(fetch).toHaveBeenCalledTimes(responses.length)
    expect(responses[3]?.body?.locked).toBe(false)
  })
})

describe('WebSocket ownership', () => {
  it('rejects new sockets after disposal and redacts invalid proxy configuration', async () => {
    const connector = subscriptionWebSocketConnector(1024)
    const factory = subscriptionWebSocket({ provider: 'openai-codex', model: 'gpt',
      timeoutMs: 1000, harnessUserAgent: 'harness' }, connector)
    expect(() => factory('wss://chatgpt.com/backend-api/codex/responses', {
      authorization: `Bearer ${codex}`, 'session-id': 's', 'x-client-request-id': 'r',
    }, { HTTPS_PROXY: 'not a valid URL' })).toThrow('proxy configuration is invalid')
    await connector.dispose()
    expect(() => connector('ws://127.0.0.1:1', {})).toThrow('connector is disposed')
  })
})

describe('fetch input preservation', () => {
  it.each(['url', 'request'] as const)('rewrites Grok %s input while retaining method and body', async (kind) => {
    const input = kind === 'url' ? new URL('https://api.x.ai/v1/responses') : new Request('https://api.x.ai/v1/responses', {
      method: 'POST', body: 'payload', headers: { Authorization: `Bearer ${grok}`, 'x-source': 'request' },
    })
    const delegate = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}'))
    const fetch = subscriptionFetch({ provider: 'xai', model: 'grok', timeoutMs: 1000, harnessUserAgent: 'harness' }, delegate)
    await fetch(input, { headers: { Authorization: `Bearer ${grok}`, 'x-source': 'init' } })
    const [target, init] = delegate.mock.calls[0]!
    expect(target instanceof URL ? target.href : target instanceof Request ? target.url : target)
      .toBe('https://cli-chat-proxy.grok.com/v1/responses')
    expect(new Headers(init?.headers).get('x-source')).toBe('init')
    expect(init?.redirect).toBe('error')
    if (target instanceof Request) {
      expect(target.method).toBe('POST')
      expect(await target.text()).toBe('payload')
    }
  })

  it.each(['https://other.test/v1/messages', 'https://api.anthropic.com/v1/other',
    'https://api.anthropic.com/v1/messages#fragment'])('leaves unrelated endpoint %s untouched', async (url) => {
    const input = new Request(url)
    const delegate = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}'))
    const fetch = subscriptionFetch({ provider: 'anthropic', model: 'claude', timeoutMs: 1000, harnessUserAgent: 'harness' }, delegate)
    await fetch(input)
    expect(delegate).toHaveBeenCalledWith(input, undefined)
  })

  it('delegates unsupported providers without replacing downstream transport', async () => {
    const ctx = new Context()
    apply(ctx)
    const downstream = { fetch: vi.fn<typeof globalThis.fetch>() }
    try {
      expect(await ctx.waterfall('llm-pi-ai/request-transport', {
        provider: 'other', model: 'model', timeoutMs: 1000, harnessUserAgent: 'harness',
      }, async () => downstream)).toBe(downstream)
    } finally { await ctx.fiber.dispose() }
  })
})
