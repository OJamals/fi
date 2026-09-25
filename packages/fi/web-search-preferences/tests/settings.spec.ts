/** Live settings and credential routing through the stable preferred-search provider. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as preferredPlugin from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function json(body: unknown): Response {
  return Response.json(body)
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

describe('preferred-search live settings', () => {
  it('extends the upstream settings namespace without renaming DeepSeek fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fi-web-search-preferences-'))
    dirs.push(dir)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(WebRuntime, { searchProvider: preferredPlugin.FI_PREFERRED_SEARCH_PROVIDER_ID })
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.plugin(MemorySettings)
    await ctx.credentials.set(credentialRef('LEGACY_DEEPSEEK_KEY'), 'legacy-secret')
    await ctx.plugin(preferredPlugin, { provider: 'deepseek-official' })
    await ctx.settings.update(preferredPlugin.WEB_SEARCH_PREFERENCES_SETTINGS_NAMESPACE, {
      provider: 'deepseek-official',
      apiKeyEnv: 'LEGACY_DEEPSEEK_KEY',
      baseURL: 'https://legacy.test/anthropic/v1',
      model: 'legacy-model',
      apiVersion: 'legacy-version',
      maxTokens: 321,
      maxUses: 2,
    })
    const fetch = vi.fn(async () => json({
      content: [{
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://source.test', title: 'Source' }],
      }],
    }))
    vi.stubGlobal('fetch', fetch)

    await ctx.web.search({ query: 'legacy settings' })

    expect(preferredPlugin.WEB_SEARCH_PREFERENCES_SETTINGS_NAMESPACE).toBe('web-search-deepseek')
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://legacy.test/anthropic/v1/messages')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('legacy-secret')
    expect(JSON.stringify(ctx.settings.describe({ redactSecrets: true }))).not.toContain('legacy-secret')
  })

  it('routes each new call from one settings snapshot and resolves the selected credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fi-web-search-preferences-'))
    dirs.push(dir)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(WebRuntime, { searchProvider: preferredPlugin.FI_PREFERRED_SEARCH_PROVIDER_ID })
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.plugin(MemorySettings)
    await ctx.credentials.set(credentialRef('EXA_API_KEY'), 'exa-secret')
    await ctx.credentials.set(credentialRef('PERPLEXITY_API_KEY'), 'pplx-secret')
    await ctx.plugin(preferredPlugin, {
      provider: 'deepseek-official',
      exaBaseURL: 'https://exa.test',
      perplexityBaseURL: 'https://perplexity.test',
    })
    const fetch = vi.fn(async (input: RequestInfo | URL) => requestUrl(input).includes('exa.test')
      ? json({ results: [{ url: 'https://source.test/exa', highlights: ['exa'] }] })
      : json({
        choices: [{ message: { content: 'perplexity' } }],
        search_results: [{ url: 'https://source.test/perplexity' }],
      }))
    vi.stubGlobal('fetch', fetch)

    await ctx.settings.update(preferredPlugin.WEB_SEARCH_PREFERENCES_SETTINGS_NAMESPACE, {
      provider: 'exa',
    })
    await expect(ctx.web.search({ query: 'one' })).resolves.toMatchObject({
      sources: [{ url: 'https://source.test/exa' }],
    })

    await ctx.settings.update(preferredPlugin.WEB_SEARCH_PREFERENCES_SETTINGS_NAMESPACE, {
      provider: 'perplexity',
    })
    await expect(ctx.web.search({ query: 'two' })).resolves.toMatchObject({
      content: 'perplexity',
      sources: [{ url: 'https://source.test/perplexity' }],
    })

    const calls = fetch.mock.calls as unknown as [RequestInfo | URL, RequestInit][]
    expect(calls.map(([input]) => requestUrl(input))).toEqual([
      'https://exa.test/search',
      'https://perplexity.test/chat/completions',
    ])
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe('Bearer exa-secret')
    expect((calls[1]![1].headers as Record<string, string>).authorization).toBe('Bearer pplx-secret')
    expect(JSON.stringify(ctx.settings.describe({ redactSecrets: true }))).not.toContain('exa-secret')
    expect(JSON.stringify(ctx.settings.describe({ redactSecrets: true }))).not.toContain('pplx-secret')
  })

  it('fails loud when subscription search is selected without its explicit provider and model', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(WebRuntime, { searchProvider: preferredPlugin.FI_PREFERRED_SEARCH_PROVIDER_ID })
    await ctx.plugin(preferredPlugin, { provider: 'subscription-native' })

    await expect(ctx.web.search({ query: 'missing subscription configuration' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
    })
  })

  it('fails before dispatch when the selected direct provider has no stored credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fi-web-search-preferences-'))
    dirs.push(dir)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(WebRuntime, { searchProvider: preferredPlugin.FI_PREFERRED_SEARCH_PROVIDER_ID })
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.plugin(preferredPlugin, { provider: 'exa', exaBaseURL: 'https://exa.test' })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(ctx.web.search({ query: 'missing credential' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
