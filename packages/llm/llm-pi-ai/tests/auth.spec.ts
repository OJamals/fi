import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { MutableModels } from '@earendil-works/pi-ai'
import { authContextFrom, credentialStoreFrom, recordKeyFor } from '../src/auth.ts'
import { createModels } from '../src/models.ts'

const CODEX = recordKeyFor('openai-codex')

const dirs: string[] = []

/** A context whose credential records live in a throwaway `$DSH_HOME`. */
async function stored(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-auth-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  return ctx
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('pi-ai credential store over harness records', () => {
  it('reads nothing for a provider with no record', async () => {
    const store = credentialStoreFrom(await stored())

    await expect(store.read('openai-codex')).resolves.toBeUndefined()
  })

  it('round-trips an api-key credential field by field', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)

    await store.modify('cloudflare', () =>
      Promise.resolve({ type: 'api_key', key: 'sk-live', env: { ACCOUNT_ID: 'acct-1' } }))

    await expect(store.read('cloudflare'))
      .resolves.toEqual({ type: 'api_key', key: 'sk-live', env: { ACCOUNT_ID: 'acct-1' } })
    await expect(ctx.credentials.readRecord(recordKeyFor('cloudflare')))
      .resolves.toEqual({ kind: 'api-key', key: 'sk-live', env: { ACCOUNT_ID: 'acct-1' } })
  })

  it('stores an api-key credential carrying neither a key nor env', async () => {
    const store = credentialStoreFrom(await stored())

    await store.modify('bedrock', () => Promise.resolve({ type: 'api_key' }))

    await expect(store.read('bedrock')).resolves.toEqual({ type: 'api_key' })
  })

  it('keeps an OAuth credential verbatim, refresh fields and all', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)
    const granted = { type: 'oauth' as const, access: 'at', refresh: 'rt', expires: 42, accountId: 'acc' }

    await store.modify('openai-codex', () => Promise.resolve(granted))

    await expect(store.read('openai-codex')).resolves.toEqual(granted)
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toEqual({ kind: 'grant', payload: granted })
  })

  it('stores the JSON image of a grant, dropping explicitly-undefined members', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)
    // The github.com Copilot shape: pi-ai sets optional members to explicit
    // undefined, which the strict record validator refuses verbatim.
    const granted = {
      type: 'oauth' as const,
      access: 'at',
      refresh: 'rt',
      expires: 42,
      enterpriseUrl: undefined,
      nested: { keep: 'x', drop: undefined },
      list: ['a', undefined, 'b'],
    }

    await store.modify('github-copilot', () => Promise.resolve(granted))

    await expect(ctx.credentials.readRecord(recordKeyFor('github-copilot'))).resolves.toEqual({
      kind: 'grant',
      payload: {
        type: 'oauth',
        access: 'at',
        refresh: 'rt',
        expires: 42,
        nested: { keep: 'x' },
        list: ['a', null, 'b'],
      },
    })
  })

  it('passes a genuinely unstorable grant value through to the store\'s loud refusal', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)
    // A foreign-prototype member is not the undefined idiom: the image leaves
    // it untouched and the record validator still refuses the write.
    const granted = { type: 'oauth' as const, access: 'at', refresh: 'rt', expires: 42, issued: new Date(0) }

    await expect(store.modify('github-copilot', () => Promise.resolve(granted)))
      .rejects.toThrow(/JSON cannot represent/)
  })

  it('shows the mutation the current credential and leaves it alone when declined', async () => {
    const store = credentialStoreFrom(await stored())
    await store.modify('openai-codex', () =>
      Promise.resolve({ type: 'oauth', access: 'first', refresh: 'r', expires: 1 }))
    const seen: unknown[] = []

    const unchanged = await store.modify('openai-codex', (current) => {
      seen.push(current)
      return Promise.resolve(undefined)
    })

    expect(seen).toEqual([{ type: 'oauth', access: 'first', refresh: 'r', expires: 1 }])
    expect(unchanged).toEqual({ type: 'oauth', access: 'first', refresh: 'r', expires: 1 })
  })

  it('lists only the records this adapter family owns', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)
    await store.modify('openai-codex', () =>
      Promise.resolve({ type: 'oauth', access: 'at', refresh: 'rt', expires: 1 }))
    await store.modify('cloudflare', () => Promise.resolve({ type: 'api_key', key: 'k' }))
    // Another plugin's record for a provider name this one also serves: its
    // payload is written in a format pi-ai never agreed to.
    await ctx.credentials.modifyRecord(credentialKey('llm-kimi', 'openai-codex'), () =>
      Promise.resolve({ kind: 'grant', payload: { theirs: true } }))

    await expect(store.list()).resolves.toEqual([
      { providerId: 'openai-codex', type: 'oauth' },
      { providerId: 'cloudflare', type: 'api_key' },
    ])
  })

  it('forgets a credential on delete, and stays quiet when there was none', async () => {
    const store = credentialStoreFrom(await stored())
    await store.modify('openai-codex', () =>
      Promise.resolve({ type: 'oauth', access: 'at', refresh: 'rt', expires: 1 }))

    await store.delete('openai-codex')
    await store.delete('openai-codex')

    await expect(store.read('openai-codex')).resolves.toBeUndefined()
  })

  it('reads empty but refuses to write without a credentials service', async () => {
    const store = credentialStoreFrom(new Context())

    await expect(store.read('openai-codex')).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
    await expect(store.modify('openai-codex', () => Promise.resolve({ type: 'api_key', key: 'k' })))
      .rejects.toThrow(/mounts no credentials service/)
    await expect(store.delete('openai-codex')).rejects.toThrow(/mounts no credentials service/)
  })

  it('treats a provider id outside the record grammar as holding nothing', async () => {
    const store = credentialStoreFrom(await stored())

    // A hand-declared route key is an arbitrary settings dict key, and pi-ai
    // reads it during auth resolution: the answer is "not signed in", never a
    // thrown address error…
    await expect(store.read('My_Proxy')).resolves.toBeUndefined()
    // …nothing can ever be stored under it, so a logout has nothing to remove…
    await expect(store.delete('My_Proxy')).resolves.toBeUndefined()
    // …while a write that cannot land must refuse rather than report success.
    await expect(store.modify('My_Proxy', () => Promise.resolve({ type: 'api_key', key: 'k' })))
      .rejects.toThrow(/cannot address a stored credential record/)
  })
})

describe('pi-ai ambient auth context', () => {
  beforeEach(() => {
    vi.stubEnv('PI_AUTH_AMBIENT', 'from-environment')
  })

  it('answers an environment name from the credential seam first', async () => {
    const ctx = await stored()
    await ctx.credentials.set(credentialRef('PI_AUTH_SEAM'), 'from-seam')

    await expect(authContextFrom(ctx).env('PI_AUTH_SEAM')).resolves.toBe('from-seam')
  })

  it('falls back to the launch environment when nothing is stored', async () => {
    await expect(authContextFrom(await stored()).env('PI_AUTH_AMBIENT')).resolves.toBe('from-environment')
  })

  it('answers "not set" for a name no reference could ever address', async () => {
    // pi-ai asks about provider-declared names; one outside the reference
    // grammar has no reference to miss, and must not throw.
    await expect(authContextFrom(await stored()).env('not a var')).resolves.toBeUndefined()
  })

  it('answers about the host filesystem, expanding a leading ~', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-home-'))
    dirs.push(dir)
    await writeFile(join(dir, 'creds'), 'x')
    // Both spellings of "home": os.homedir() reads HOME on POSIX and
    // USERPROFILE on Windows, and the expansion under test goes through it.
    vi.stubEnv('HOME', dir)
    vi.stubEnv('USERPROFILE', dir)
    const context = authContextFrom(await stored())

    await expect(context.fileExists('~/creds')).resolves.toBe(true)
    await expect(context.fileExists('~/missing')).resolves.toBe(false)
    await expect(context.fileExists(join(dir, 'creds'))).resolves.toBe(true)
    await expect(context.fileExists('~')).resolves.toBe(true)
  })
})

describe('pi-ai OAuth refresh through the harness credential seam', () => {
  /**
   * A real `Models` collection carrying one installed subscription provider,
   * authenticated entirely through this adapter family's store and ambient
   * context — the same construction `PiAiAdapter` uses, minus the profile
   * and stream machinery this test does not need.
   */
  function subscriptionModels(ctx: Context): MutableModels {
    const models = createModels({ credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) })
    const xai = builtinProviders().find(provider => provider.id === 'xai')
    if (xai === undefined) throw new Error('pi-ai no longer ships a builtin "xai" provider')
    models.setProvider(xai)
    return models
  }

  it('refreshes a near-expiry grant exactly once and persists the rotated record', async () => {
    const ctx = await stored()
    const key = recordKeyFor('xai')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant',
      payload: { type: 'oauth', access: 'stale-access', refresh: 'refresh-1', expires: Date.now() - 1_000 },
    }))
    const fetchSpy = vi.fn(async () => Response.json({
      access_token: 'fresh-access',
      refresh_token: 'refresh-2',
      expires_in: 3600,
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const models = subscriptionModels(ctx)

    // Two requests race against the same expired grant; pi-ai's resolver
    // locks the store around the refresh, so only one reaches the network
    // and the second observes the rotation the first one persisted.
    const [first, second] = await Promise.all([models.getAuth('xai'), models.getAuth('xai')])

    expect(first?.auth).toEqual({ apiKey: 'fresh-access' })
    expect(second?.auth).toEqual({ apiKey: 'fresh-access' })
    expect(fetchSpy).toHaveBeenCalledOnce()
    await expect(ctx.credentials.readRecord(key)).resolves.toMatchObject({
      kind: 'grant',
      payload: { access: 'fresh-access', refresh: 'refresh-2' },
    })
  })

  it('serves a still-valid grant with no network call', async () => {
    const ctx = await stored()
    await ctx.credentials.modifyRecord(recordKeyFor('xai'), () => Promise.resolve({
      kind: 'grant',
      payload: { type: 'oauth', access: 'live-access', refresh: 'refresh-1', expires: Date.now() + 3_600_000 },
    }))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const models = subscriptionModels(ctx)

    await expect(models.getAuth('xai')).resolves.toEqual({ auth: { apiKey: 'live-access' }, source: 'OAuth' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
