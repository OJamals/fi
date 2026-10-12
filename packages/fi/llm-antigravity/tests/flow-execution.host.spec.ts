/** OAuth flow persists exchanged grants and rejects callbacks from another attempt. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { exchangeAntigravityCode, waitForAntigravityCallback } from '../src/auth/oauth.ts'
import { runAntigravityDiscovery } from '../src/auth/discovery.ts'
import {
  ANTIGRAVITY_CREDENTIAL_ID, ANTIGRAVITY_CREDENTIAL_SCOPE, ANTIGRAVITY_OAUTH_CLIENT_ID_REF, ANTIGRAVITY_OAUTH_CLIENT_SECRET_REF,
  DISABLED_ANTIGRAVITY_DISCOVERY, registerAntigravityFlow, resolveAntigravityOAuthClient,
} from '../src/index.ts'

vi.mock('../src/auth/oauth.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/auth/oauth.ts')>(),
  waitForAntigravityCallback: vi.fn(), exchangeAntigravityCode: vi.fn(),
}))
vi.mock('../src/auth/discovery.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/auth/discovery.ts')>(), runAntigravityDiscovery: vi.fn(),
}))
afterEach(() => { vi.resetAllMocks() })

async function context() {
  const root = await mkdtemp(join(tmpdir(), 'fi-oauth-flow-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalCredentialProvider, { path: join(root, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  return ctx
}

it.each([true, false])('OAuth callback belongs to this attempt: %s', async (matches) => {
  const ctx = await context()
  await ctx.credentials.set(credentialRef(ANTIGRAVITY_OAUTH_CLIENT_ID_REF), 'fixture-client')
  await ctx.credentials.set(credentialRef(ANTIGRAVITY_OAUTH_CLIENT_SECRET_REF), 'fixture-secret')
  registerAntigravityFlow(ctx)
  let state = ''
  vi.mocked(waitForAntigravityCallback).mockImplementation(async () => ({ code: 'code', state: matches ? state : 'another-attempt' }))
  vi.mocked(exchangeAntigravityCode).mockResolvedValue({
    provider: 'antigravity', accessToken: 'access', refreshToken: 'refresh', expiresAt: '2030-01-01T00:00:00Z',
    email: 'fixture@example.test', accountUuid: 'project', antigravityProjectId: 'project', idToken: 'id',
  })
  const key = credentialKey(ANTIGRAVITY_CREDENTIAL_SCOPE, ANTIGRAVITY_CREDENTIAL_ID)
  const attempt = ctx.authorization.begin({ key, interaction: {
    notify(notice) { state = new URL(notice.url!).searchParams.get('state')! },
    prompt: async () => { throw new Error('unexpected prompt') },
  } })
  if (!matches) {
    await expect(attempt).rejects.toThrow('OAuth state mismatch')
    expect(exchangeAntigravityCode).not.toHaveBeenCalled()
    return
  }
  await attempt
  expect(await ctx.credentials.readRecord(key)).toMatchObject({
    kind: 'grant', payload: { type: 'oauth', access: 'access', refresh: 'refresh', email: 'fixture@example.test', antigravityProjectId: 'project' },
  })
})

it('persists a discovered OAuth client and reuses it without another scan', async () => {
  const ctx = await context()
  vi.mocked(runAntigravityDiscovery).mockResolvedValue({ clientId: 'discovered-client', clientSecret: 'discovered-secret' })
  const client = await resolveAntigravityOAuthClient(ctx)
  expect(client).toEqual({ clientId: 'discovered-client', clientSecret: 'discovered-secret' })
  expect(await resolveAntigravityOAuthClient(ctx)).toEqual(client)
  expect(runAntigravityDiscovery).toHaveBeenCalledTimes(1)
})

it.each([ANTIGRAVITY_OAUTH_CLIENT_ID_REF, ANTIGRAVITY_OAUTH_CLIENT_SECRET_REF])('does not overwrite a partially configured client: %s', async (ref) => {
  const ctx = await context()
  await ctx.credentials.set(credentialRef(ref), 'configured')
  await expect(resolveAntigravityOAuthClient(ctx)).rejects.toThrow('set it as an environment variable')
  expect(runAntigravityDiscovery).not.toHaveBeenCalled()
})

it('refuses discovery without a durable credential store', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await expect(resolveAntigravityOAuthClient(ctx, undefined, DISABLED_ANTIGRAVITY_DISCOVERY)).rejects.toThrow('set them as an environment variable')
  expect(runAntigravityDiscovery).not.toHaveBeenCalled()
})
