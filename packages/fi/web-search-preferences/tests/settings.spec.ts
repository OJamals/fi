/** Live settings and credential routing through the stable preferred-search provider. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import Settings from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as preferredPlugin from '../src/index.ts'

const homes: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function json(body: unknown): Response {
  return Response.json(body)
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/**
 * A real profile-backed context with credentials, the web registry, and the
 * preferred-search plugin under test. `ctx.settings` now projects real
 * profile-entry Config schemas through `@deepseek-ai/dsh-config-editor`, so
 * exercising `settings.update`/`describe` needs a booted profile rather than
 * a hand-rolled settings provider.
 * @param config - the plugin's initial declared configuration.
 */
async function harness(config: Record<string, unknown> = {}): Promise<Context> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'fi-web-search-preferences-')))
  homes.push(home)
  const dir = join(home, 'profiles', 'test')
  const bundle = join(dir, 'node_modules', 'test-bundle')
  initProfile(dir, ['test-bundle'])
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'credentials', name: 'cordis:credentials', config: { path: join(home, '.credentials.yaml'), watch: false } },
    { id: 'web', name: 'cordis:web', config: { searchProvider: preferredPlugin.FI_PREFERRED_SEARCH_PROVIDER_ID } },
    { id: preferredPlugin.WEB_SEARCH_PREFERENCES_SETTINGS_NAMESPACE, name: 'cordis:preferred', config },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, {
      editor: ConfigEditor,
      settings: Settings,
      credentials: LocalCredentialProvider,
      web: WebRuntime,
      preferred: preferredPlugin,
    })
  })
  contexts.push(ctx)
  return ctx
}

describe('preferred-search live settings', () => {
  it('keeps DeepSeek\'s field names unrenamed under fi\'s own settings namespace', async () => {
    const ctx = await harness({ provider: 'deepseek-official' })
    await ctx.credentials.set(credentialRef('LEGACY_DEEPSEEK_KEY'), 'legacy-secret')
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

    expect(preferredPlugin.WEB_SEARCH_PREFERENCES_SETTINGS_NAMESPACE).toBe('fi-web-search-preferences')
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://legacy.test/anthropic/v1/messages')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('legacy-secret')
    expect(JSON.stringify(ctx.settings.describe({ redactSecrets: true }))).not.toContain('legacy-secret')
  })

  it('routes each new call from one settings snapshot and resolves the selected credential', async () => {
    const ctx = await harness({
      provider: 'deepseek-official',
      exaBaseURL: 'https://exa.test',
      perplexityBaseURL: 'https://perplexity.test',
    })
    await ctx.credentials.set(credentialRef('EXA_API_KEY'), 'exa-secret')
    await ctx.credentials.set(credentialRef('PERPLEXITY_API_KEY'), 'pplx-secret')
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
    const ctx = await harness({ provider: 'subscription-native' })

    await expect(ctx.web.search({ query: 'missing subscription configuration' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
    })
  })

  it('fails before dispatch when the selected direct provider has no stored credential', async () => {
    const ctx = await harness({ provider: 'exa', exaBaseURL: 'https://exa.test' })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(ctx.web.search({ query: 'missing credential' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
