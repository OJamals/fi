import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import * as subscriptionPlugin from '../src/index.ts'

const dirs: string[] = []
const contexts: Context[] = []

function trackedContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

function codexToken(): string {
  const payload = { 'https://api.openai.com/auth': { chatgpt_account_id: 'account-fixture' } }
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function responseSse(): string {
  return [
    { type: 'response.output_item.done', item: { id: 's', type: 'web_search_call', status: 'completed' } },
    {
      type: 'response.output_item.done',
      item: {
        id: 'm', type: 'message', content: [{
          type: 'output_text', text: 'Fact', annotations: [{
            type: 'url_citation', url: 'https://example.com/source', title: 'Source', start_index: 0, end_index: 4,
          }],
        }],
      },
    },
    { type: 'response.completed', response: { status: 'completed' } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

async function composition(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'fi-subscription-search-'))
  dirs.push(dir)
  const ctx = trackedContext()
  await ctx.plugin(WebRuntime, { searchProvider: subscriptionPlugin.SUBSCRIPTION_SEARCH_PROVIDER_ID })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await credentialStoreFrom(ctx).modify('openai-codex', () => Promise.resolve({
    type: 'oauth',
    access: codexToken(),
    refresh: 'refresh-fixture',
    expires: Date.now() + 60 * 60 * 1000,
    accountId: 'account-fixture',
  }))
  return ctx
}

afterEach(async () => {
  const disposals = await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  const failed = disposals.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed !== undefined) throw failed.reason
})

describe('subscription search plugin composition', () => {
  it('resolves Antigravity credentials from its injected plugin context', async () => {
    const ctx = await composition()
    await ctx.credentials.modifyRecord(credentialKey('fi-antigravity', 'antigravity'), () => Promise.resolve({
      kind: 'grant', payload: { access: 'fixture-access', projectId: 'fixture-project' },
    }))
    const fetch = vi.fn(async () => new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    await ctx.plugin(subscriptionPlugin, { provider: 'antigravity', model: 'antigravity-gemini-3-flash' })
    await expect(ctx.web.search({ query: 'weather' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_UPSTREAM_ERROR', status: 403,
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps the namespace plugin through the real Loader and registers with WebRuntime', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(responseSse(), {
      headers: { 'content-type': 'text/event-stream' },
    })))
    const ctx = await composition()
    const loader = Object.create(Loader.prototype) as Loader
    const plugin = loader.unwrapExports(subscriptionPlugin) as Parameters<Context['plugin']>[0]
    expect(plugin).toBe(subscriptionPlugin)

    const fiber = await ctx.plugin(plugin, {
      provider: 'codex',
      model: 'gpt-5.6-sol',
    })
    await expect(ctx.web.search({ query: 'weather' })).resolves.toMatchObject({
      sources: [{ url: 'https://example.com/source' }],
    })

    await fiber.dispose()
    await expect(ctx.web.search({ query: 'weather' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
    await ctx.fiber.dispose()
  })

  it('makes effect disposal abort and await an in-flight request before completing HMR teardown', async () => {
    let fetchSettled = false
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => {
          queueMicrotask(() => {
            fetchSettled = true
            reject(signal?.reason instanceof Error ? signal.reason : new Error('search aborted'))
          })
        }, { once: true })
      })))
    const ctx = await composition()
    const fiber = await ctx.plugin(subscriptionPlugin, {
      provider: 'codex',
      model: 'gpt-5.6-sol',
    })
    const search = ctx.web.search({ query: 'weather' })
    await vi.waitFor(() => { expect(globalThis.fetch).toHaveBeenCalledTimes(1) })

    await fiber.dispose()

    expect(fetchSettled).toBe(true)
    await expect(search).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    await expect(ctx.web.search({ query: 'weather' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
    await ctx.fiber.dispose()
  })

  it('projects the owner-local normalized golden through the actual web_search tool', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(responseSse(), {
      headers: { 'content-type': 'text/event-stream' },
    })))
    const dir = await mkdtemp(join(tmpdir(), 'fi-subscription-tool-search-'))
    dirs.push(dir)
    const ctx = trackedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(WebRuntime, { searchProvider: subscriptionPlugin.SUBSCRIPTION_SEARCH_PROVIDER_ID })
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await credentialStoreFrom(ctx).modify('openai-codex', () => Promise.resolve({
      type: 'oauth',
      access: codexToken(),
      refresh: 'refresh-fixture',
      expires: Date.now() + 60 * 60 * 1000,
      accountId: 'account-fixture',
    }))
    await ctx.plugin(subscriptionPlugin, { provider: 'codex', model: 'gpt-5.6-sol' })
    await ctx.plugin(ToolWeb, { fetch: false })

    const output = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('subscription-search-golden'),
      name: 'web_search',
      arguments: { queries: ['weather'] },
    })
    const expected = JSON.parse(await readFile(
      new URL('./expected/native-search.json', import.meta.url),
      'utf8',
    )) as unknown

    expect(output.isError).toBe(false)
    if (output.isError) throw new Error('web_search unexpectedly failed')
    expect(output.value).toEqual(expected)
    expect(output.meta).toEqual({
      answer: 'Fact',
      sources: [{ url: 'https://example.com/source', title: 'Source' }],
      truncated: false,
    })
    expect(output.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .toContain('[Source](https://example.com/source)')
    await ctx.fiber.dispose()
  })

  it.each([
    [{ provider: 'codex' }, /model/],
    [{ model: 'gpt-5.6-sol' }, /provider/],
    [{ provider: 'codex', model: 'gpt-5.6-sol', timeoutMs: 0 }, /timeoutMs/],
    [{ provider: 'codex', model: 'gpt-5.6-sol', maxResponseBytes: 0 }, /maxResponseBytes/],
    [{ provider: 'codex', model: 'gpt-5.6-sol', maxUses: 0 }, /maxUses/],
  ])('rejects incomplete or invalid explicit config %#', async (config, message) => {
    const ctx = await composition()
    await expect(ctx.plugin(subscriptionPlugin, config as subscriptionPlugin.Config)).rejects.toThrow(message)
    await ctx.fiber.dispose()
  })
})
