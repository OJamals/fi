/** Cursor's own OAuth refresh grant. */
import { afterEach, expect, it, vi } from 'vitest'
import { refreshCursor } from '../src/cursor-auth.ts'
import type { SubscriptionGrant, SubscriptionOptions } from '../src/protocol.ts'

afterEach(() => { vi.unstubAllGlobals() })
const config = { requestTimeoutMs: 1000 } as SubscriptionOptions
const jwt = (claims: Record<string, unknown>) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
const exp = () => Math.floor(Date.now() / 1000) + 3600
const grant = (overrides: Partial<SubscriptionGrant> = {}): SubscriptionGrant => ({
  provider: 'cursor',
  accessToken: jwt({ sub: 'auth0|user', exp: exp() - 10 }),
  refreshToken: 'refresh-secret',
  expiresAt: '2000-01-01T00:00:00.000Z',
  subscriptionAuth: { machineId: 'machine' },
  ...overrides,
})
const respond = (value: () => Response | Promise<Response>) => {
  const fetchMock = vi.fn((_input: string, _init: RequestInit) => Promise.resolve().then(value))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

it('exchanges the stored refresh token and keeps account identity, machine id, and refresh token', async () => {
  const next = jwt({ sub: 'auth0|user', exp: exp() })
  const fetchMock = respond(() => Response.json({ access_token: next, id_token: 'ignored' }))
  const refreshed = await refreshCursor(grant(), config)
  expect(refreshed).toEqual(expect.objectContaining({
    provider: 'cursor', accessToken: next, refreshToken: 'refresh-secret', subscriptionAuth: { machineId: 'machine' },
  }))
  expect(Date.parse(refreshed.expiresAt)).toBeGreaterThan(Date.now())
  const [url, init] = fetchMock.mock.calls[0] ?? []
  expect(url).toBe('https://api2.cursor.sh/oauth/token')
  expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
  expect(JSON.parse(init?.body as string)).toEqual({ grant_type: 'refresh_token', client_id: 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB', refresh_token: 'refresh-secret' })
  // Without a subject on either token the identity check has nothing to compare.
  respond(() => Response.json({ access_token: jwt({ exp: exp() }) }))
  await expect(refreshCursor(grant(), config)).resolves.toBeDefined()
  respond(() => Response.json({ access_token: next }))
  await expect(refreshCursor(grant({ accessToken: 'opaque-token' }), config)).resolves.toBeDefined()
})

it('requires a refresh token and reports revoked, failing, and unusable replies without exposing them', async () => {
  const fetchMock = respond(() => Response.json({}))
  await expect(refreshCursor(grant({ refreshToken: '' }), config)).rejects.toThrow('sign in again')
  expect(fetchMock).not.toHaveBeenCalled()
  for (const status of [401, 403]) {
    respond(() => new Response('secret detail', { status }))
    await expect(refreshCursor(grant(), config)).rejects.toThrow('revoked; sign in again')
  }
  respond(() => new Response('secret detail', { status: 500 }))
  await expect(refreshCursor(grant(), config)).rejects.toThrow('Cursor token refresh failed (500)')
  respond(() => Response.json({ shouldLogout: true }))
  await expect(refreshCursor(grant(), config)).rejects.toThrow('requested a new login')
  respond(() => Response.json({}))
  await expect(refreshCursor(grant(), config)).rejects.toThrow('returned no access token')
  respond(() => Response.json({ access_token: '' }))
  await expect(refreshCursor(grant(), config)).rejects.toThrow('returned no access token')
  respond(() => Response.json({ access_token: 3 }))
  await expect(refreshCursor(grant(), config)).rejects.toThrow()
  for (const claims of [{ sub: 'auth0|user' }, { sub: 'auth0|user', exp: Math.floor(Date.now() / 1000) - 100 }, { sub: 'auth0|user', exp: 9e15 }]) {
    respond(() => Response.json({ access_token: jwt(claims) }))
    await expect(refreshCursor(grant(), config)).rejects.toThrow('invalid token expiry')
  }
  respond(() => Response.json({ access_token: 'not-a-jwt' }))
  await expect(refreshCursor(grant(), config)).rejects.toThrow('invalid token expiry')
  respond(() => Response.json({ access_token: jwt({ sub: 'auth0|someone-else', exp: exp() }) }))
  await expect(refreshCursor(grant(), config)).rejects.toThrow('different account')
})
