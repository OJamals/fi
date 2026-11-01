/** Shared protocol helpers and catalog request edges. */
import { afterEach, expect, it, vi } from 'vitest'
import { catalog } from '../src/catalog.ts'
import { json, kiroRegion, retryAfterMs, withTimeoutSignal } from '../src/protocol.ts'
import type { SubscriptionGrant, SubscriptionOptions } from '../src/protocol.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const options = { requestTimeoutMs: 1000 } as SubscriptionOptions
const grant = (provider: SubscriptionGrant['provider'], extra: Partial<SubscriptionGrant> = {}): SubscriptionGrant => ({
  provider, accessToken: 'token', refreshToken: '', expiresAt: '2099-01-01T00:00:00.000Z', ...extra,
})

it('reads Retry-After as seconds or an HTTP date and ignores anything unusable', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  expect(retryAfterMs('7', now)).toBe(7000)
  expect(retryAfterMs('0.25', now)).toBe(250)
  expect(retryAfterMs(new Date(now + 90_000).toUTCString(), now)).toBe(90_000)
  for (const value of [null, '', '0', '-5', 'soon', new Date(now - 1000).toUTCString()]) expect(retryAfterMs(value, now), String(value)).toBeUndefined()
  expect(retryAfterMs('2')).toBe(2000)
})

it('combines a deadline with caller cancellation and validates the Kiro region', async () => {
  const caller = new AbortController()
  const signal = withTimeoutSignal(60_000, caller.signal)
  expect(signal.aborted).toBe(false)
  caller.abort()
  expect(signal.aborted).toBe(true)
  expect(withTimeoutSignal(60_000).aborted).toBe(false)
  expect(kiroRegion()).toBe('us-east-1')
  expect(kiroRegion({ region: 'eu-central-1' })).toBe('eu-central-1')
  expect(() => kiroRegion({ region: 'evil.example.com/' })).toThrow('Invalid Kiro region')
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('secret body', { status: 503 }))))
  await expect(json('https://example.test/x', options)).rejects.toThrow('Subscription endpoint failed (503)')
})

it('lists Kiro models under a caller cancellation signal and refuses a Code Assist account without a project', async () => {
  const seen: Request[] = []
  vi.stubGlobal('fetch', vi.fn((input: string, init: RequestInit) => {
    seen.push(new Request(input, init))
    return Promise.resolve(Response.json({ models: [{ modelId: 'claude-sonnet-4.5' }] }))
  }))
  const controller = new AbortController()
  expect(await catalog(grant('kiro'), options, controller.signal)).toEqual(['claude-sonnet-4.5'])
  expect(seen[0]?.headers.get('user-agent')).toContain('codewhispererruntime')
  expect(seen[0]?.headers.get('accept')).toBe('application/json')
  await expect(catalog(grant('gemini-cli'), options)).rejects.toThrow('Code Assist has no project')
})
