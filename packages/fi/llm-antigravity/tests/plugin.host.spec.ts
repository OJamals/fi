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
import LlmRuntime, { fileHandleText } from '@deepseek-ai/dsh-llm'

import FiAntigravityService, {
  ANTIGRAVITY_CREDENTIAL_KEY,
  resolveAntigravityGrant,
} from '../src/index.ts'
import { ANTIGRAVITY_STATIC_CATALOG } from '../src/catalog.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const dirs: string[] = []

/**
 * A context with the record store, the llm runtime, and the plugin mounted
 * as a real Loader entry named `fi-antigravity` — the id a real profile
 * gives it — so its Config's volatile `providers` dict can be edited live
 * the same way `ctx.settings.mutate` would, without booting a full profile.
 */
async function harness(services?: {
  readonly attachments?: { fileHostPath(ref: unknown): string | undefined }
  readonly fs?: { processPathFromHostPath(path: string): string | undefined }
}): Promise<{ ctx: Context; live: Awaited<ReturnType<typeof liveConfig>> }> {
  const dir = await mkdtemp(join(tmpdir(), 'fi-agy-plugin-'))
  dirs.push(dir)
  const ctx = new Context()
  if (services?.attachments !== undefined) ctx.provide('attachments', services.attachments as never)
  if (services?.fs !== undefined) ctx.provide('fs', services.fs as never)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AuthorizationService)
  const live = await liveConfig(ctx, FiAntigravityService, {}, 'fi-antigravity')
  return { ctx, live }
}

/** The resolved providers dict of the fi-antigravity namespace. */
function routes(live: Awaited<ReturnType<typeof liveConfig>>): Record<string, unknown> {
  return (live.fiber.config as { providers: { get(): Record<string, unknown> } }).providers.get()
}

/** Parse the JSON body one scripted fetch call received. */
function jsonBody(init: RequestInit): unknown {
  if (typeof init.body !== 'string') throw new Error('expected a JSON string request body')
  return JSON.parse(init.body) as unknown
}

/** One complete upstream Gemini SSE response. */
function upstreamText(text: string): Response {
  const payload = JSON.stringify({
    response: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] },
  })
  return new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('FiAntigravityService', () => {
  it('registers the sign-in flow on the authorization seam', async () => {
    const { ctx } = await harness()
    const entries = ctx.authorization.list()
    const entry = entries.find(candidate => candidate.key === ANTIGRAVITY_CREDENTIAL_KEY)
    expect(entry?.label).toBe('Antigravity')
    expect(entry?.methods.some(method => method.id === 'oauth')).toBe(true)
  })

  it('declares the Antigravity directory entry the Models page reads', async () => {
    const { ctx } = await harness()
    const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === 'antigravity')
    expect(entry).toMatchObject({
      displayName: 'Antigravity',
      settingsNs: 'fi-antigravity',
      settingsPath: ['providers', 'antigravity'],
    })
  })

  it('is dormant on a bare mount and takes routes live from the section', async () => {
    const { ctx, live } = await harness()
    expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('antigravity')

    await live.update({ providers: { antigravity: {} } })
    expect(routes(live)).toEqual({ antigravity: {} })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('antigravity')

    await live.replace({ providers: {} })
    expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('antigravity')
  })

  it('answers discovery for its namespace from the static catalog when signed out', async () => {
    const { ctx } = await harness()
    const models = await ctx.llm.discoverModels('fi-antigravity', { provider: 'antigravity' })
    expect(models.length).toBe(ANTIGRAVITY_STATIC_CATALOG.length)
    expect(models.map(model => model.id)).toContain('antigravity-claude-sonnet-4-6')
  })

  it('serves a signed-out request as an honest error finish, not a throw', async () => {
    const { ctx, live } = await harness()
    await live.update({ providers: { antigravity: {} } })
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
    const { ctx } = await harness()
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

  it('exports the same serialized refreshing grant resolver used by the adapter', async () => {
    const { ctx } = await harness()
    const key = credentialKey('fi-antigravity', 'antigravity')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant',
      payload: {
        access: 'expired-access',
        refresh: 'refresh-1',
        expires: Date.now() + 1_000,
        projectId: 'project-1',
        email: 'person@example.test',
      },
    }))
    const fetchSpy = vi.fn(async () => Response.json({
      access_token: 'fresh-access',
      refresh_token: 'refresh-2',
      expires_in: 3600,
    }))
    vi.stubGlobal('fetch', fetchSpy)
    await expect(resolveAntigravityGrant(ctx)).resolves.toEqual({
      accessToken: 'fresh-access',
      projectId: 'project-1',
    })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const stored = await ctx.credentials.readRecord(key)
    expect(stored).toMatchObject({
      kind: 'grant',
      payload: {
        access: 'fresh-access',
        refresh: 'refresh-2',
        projectId: 'project-1',
        email: 'person@example.test',
      },
    })
  })

  it('serializes concurrent resolution of a near-expiry grant into exactly one refresh', async () => {
    // Two overlapping resolveAntigravityGrant calls both read the same
    // near-expiry record before either writes. modifyRecord serializes their
    // writes, but only the recheck inside the callback — not the seam's
    // serialization alone — stops the second writer from refreshing again:
    // it must see the first writer's already-fresh record and no-op.
    const { ctx } = await harness()
    const key = credentialKey('fi-antigravity', 'antigravity')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant',
      payload: {
        access: 'expired-access',
        refresh: 'refresh-1',
        expires: Date.now() + 1_000,
        projectId: 'project-1',
        email: 'person@example.test',
      },
    }))
    const fetchSpy = vi.fn(async () => Response.json({
      access_token: 'fresh-access',
      refresh_token: 'refresh-2',
      expires_in: 3600,
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const [first, second] = await Promise.all([
      resolveAntigravityGrant(ctx),
      resolveAntigravityGrant(ctx),
    ])
    expect(first).toEqual({ accessToken: 'fresh-access', projectId: 'project-1' })
    expect(second).toEqual({ accessToken: 'fresh-access', projectId: 'project-1' })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const stored = await ctx.credentials.readRecord(key)
    expect(stored).toMatchObject({
      kind: 'grant',
      payload: {
        access: 'fresh-access',
        refresh: 'refresh-2',
        projectId: 'project-1',
        email: 'person@example.test',
      },
    })
  })

  it('rejects OAuth redirects and redacts a failed refresh response body', async () => {
    const { ctx } = await harness()
    const key = credentialKey('fi-antigravity', 'antigravity')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant',
      payload: {
        access: 'expired-access',
        refresh: 'refresh-1',
        expires: Date.now() + 1_000,
        projectId: 'project-1',
      },
    }))
    const cancelled = vi.fn()
    const secret = 'account@example.test echoed-refresh-token request-data'
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(secret)) },
      cancel: cancelled,
    }), { status: 401 }))
    vi.stubGlobal('fetch', fetchSpy)

    const error = await resolveAntigravityGrant(ctx).then(
      () => new Error('refresh unexpectedly succeeded'),
      (value: unknown) => value instanceof Error ? value : new Error(String(value)),
    )
    expect(error.message).toBe('Antigravity OAuth token request failed (401)')
    expect(error.message).not.toContain(secret)
    expect(fetchSpy.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true)
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('keeps durable files on the harness-wide deterministic text projection', async () => {
    const { ctx, live } = await harness({
      attachments: { fileHostPath: () => '/host/notes.pdf' },
      fs: { processPathFromHostPath: () => '/sandbox/read-only/notes.pdf' },
    })
    await live.update({ providers: { antigravity: {} } })
    await ctx.credentials.modifyRecord(
      credentialKey('fi-antigravity', 'antigravity'),
      () => Promise.resolve({
        kind: 'grant',
        payload: { access: 'ya29.test', expires: Date.now() + 3_600_000, projectId: 'project-1' },
      }),
    )
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstreamText('read'))
    vi.stubGlobal('fetch', fetchSpy)
    const file = { attachmentId: `sha256:${'ab'.repeat(32)}` as never, name: 'notes.pdf', bytes: 5 }
    for await (const _chunk of ctx.llm.stream({
      provider: 'antigravity',
      model: 'claude-sonnet-4-6',
      messages: [{
        id: 'm-file' as never,
        role: 'user',
        content: [{ type: 'file', attachment: file }],
        source: { kind: 'user' },
      }],
    })) { /* drain */ }
    const [, init] = fetchSpy.mock.calls[0] ?? []
    if (init === undefined) throw new Error('expected fetch request init')
    const envelope = jsonBody(init) as {
      request: { contents: { parts: { text?: string }[] }[] }
    }
    expect(envelope.request.contents[0]?.parts).toEqual([{
      text: fileHandleText(file, '/sandbox/read-only/notes.pdf'),
    }])
    expect(envelope.request.contents[0]?.parts[0]?.text).toContain(
      'Read that path with your file tools when its contents are needed',
    )
  })

  it('a stored grant backs the route the sign-in flow commits to', async () => {
    const { ctx } = await harness()
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
