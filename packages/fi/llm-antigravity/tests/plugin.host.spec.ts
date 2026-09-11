/**
 * The Antigravity plugin's Host wiring: with the seams mounted, the service
 * registers the sign-in flow, declares its directory entry, serves model
 * discovery for its own settings namespace, and takes routes live only while
 * the section declares profiles — the dormant bare-mount posture the pi-ai
 * plugin set the pattern for.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

import FiAntigravityService, { ANTIGRAVITY_CREDENTIAL_KEY } from '../src/index.ts'
import { ANTIGRAVITY_STATIC_CATALOG } from '../src/catalog.ts'

const dirs: string[] = []

/** In-memory settings provider: the smallest real SettingsProvider subclass. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** A context with the record store, settings, the llm runtime, and the plugin. */
async function harness(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'fi-agy-plugin-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(MemorySettings)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(FiAntigravityService)
  return ctx
}

/** The resolved providers dict of the fi-antigravity namespace. */
function routes(ctx: Context): Record<string, unknown> {
  const view = ctx.settings.describe().find(candidate => candidate.ns === 'fi-antigravity')
  return (view?.value as { providers?: Record<string, unknown> } | undefined)?.providers ?? {}
}

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('FiAntigravityService', () => {
  it('registers the sign-in flow on the authorization seam', async () => {
    const ctx = await harness()
    const entries = await ctx.authorization.list()
    const entry = entries.find(candidate => candidate.key === ANTIGRAVITY_CREDENTIAL_KEY)
    expect(entry?.label).toBe('Antigravity')
    expect(entry?.methods.some(method => method.id === 'oauth')).toBe(true)
  })

  it('declares the Antigravity directory entry the Models page reads', async () => {
    const ctx = await harness()
    const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === 'antigravity')
    expect(entry).toMatchObject({
      displayName: 'Antigravity',
      settingsNs: 'fi-antigravity',
      settingsPath: ['providers', 'antigravity'],
    })
  })

  it('is dormant on a bare mount and takes routes live from the section', async () => {
    const ctx = await harness()
    expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('antigravity')

    await ctx.settings.mutate('fi-antigravity' as never, [
      { op: 'set', path: ['providers', 'antigravity'], value: {} },
    ] as never)
    expect(routes(ctx)).toEqual({ antigravity: {} })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('antigravity')

    await ctx.settings.mutate('fi-antigravity' as never, [
      { op: 'unset', path: ['providers', 'antigravity'] },
    ] as never)
    expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('antigravity')
  })

  it('answers discovery for its namespace from the static catalog when signed out', async () => {
    const ctx = await harness()
    const models = await ctx.llm.discoverModels('fi-antigravity', { provider: 'antigravity' })
    expect(models.length).toBe(ANTIGRAVITY_STATIC_CATALOG.length)
    expect(models.map(model => model.id)).toContain('antigravity-claude-sonnet-4-6')
  })

  it('serves a signed-out request as an honest error finish, not a throw', async () => {
    const ctx = await harness()
    await ctx.settings.mutate('fi-antigravity' as never, [
      { op: 'set', path: ['providers', 'antigravity'], value: {} },
    ] as never)
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'antigravity',
      model: 'claude-sonnet-4-6',
      messages: [{ id: 'm1' as never, role: 'user', content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } }],
    } as never)) chunks.push(chunk)
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe('fi-antigravity/no-grant')
  })

  it('resolves a grant record carrying the pre-profile shape: projectId key, no type tag', async () => {
    // The live store was found holding `{access, refresh, expires,
    // projectId}` — no `type: 'oauth'`, no `antigravityProjectId`. The
    // narrowing must accept it: the record key is already scoped to this
    // plugin's flow, so structure (an access token) is the whole check.
    const ctx = await harness()
    await ctx.credentials.modifyRecord(
      credentialKey('fi-antigravity', 'antigravity'),
      () => Promise.resolve({
        kind: 'grant',
        payload: { access: 'ya29.test', refresh: 'r1', expires: Date.now() + 3_600_000, projectId: 'project-1' },
      }),
    )
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      models: { 'gemini-pro-agent': {} },
      agentModelSorts: [{ groups: [{ modelIds: ['gemini-pro-agent'] }] }],
      imageGenerationModelIds: [],
    })))
    const models = await ctx.llm.discoverModels('fi-antigravity', { provider: 'antigravity' })
    expect(models.map(model => model.id)).toContain('gemini-3.1-pro-high')
  })

  it('a stored grant backs the route the sign-in flow commits to', async () => {
    const ctx = await harness()
    await ctx.credentials.modifyRecord(
      credentialKey('fi-antigravity', 'antigravity'),
      () => Promise.resolve({
        kind: 'grant',
        payload: { type: 'oauth', access: 'ya29.test', antigravityProjectId: 'project-1' },
      }),
    )
    const entry = await ctx.credentials.describeRecord(credentialKey('fi-antigravity', 'antigravity'))
    expect(entry.configured).toBe(true)
  })
})
