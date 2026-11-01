/** Copilot origin, client identity, and premium-quota reset reporting. */
import { afterEach, expect, it, vi } from 'vitest'
import {
  annotateQuotaFailure,
  callCopilot,
  copilotBase,
  copilotHeaders,
  isCopilotQuotaFailure,
  parseCopilotQuotaSnapshot,
} from '../src/copilot.ts'
import type { SubscriptionGrant } from '../src/protocol.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const grant: SubscriptionGrant = {
  provider: 'copilot',
  accessToken: 'copilot-token',
  refreshToken: 'github-token',
  expiresAt: '9999-01-01T00:00:00.000Z',
  subscriptionAuth: { apiBase: 'https://api.business.githubcopilot.com' },
}
const now = Date.parse('2026-11-10T12:00:00Z')
const snapshot = (fields: Record<string, string>) => new URLSearchParams(fields).toString()

it('constrains the API origin to GitHub Copilot hosts', () => {
  expect(copilotBase(grant)).toBe('https://api.business.githubcopilot.com')
  expect(copilotBase({ ...grant, subscriptionAuth: undefined })).toBe('https://api.individual.githubcopilot.com')
  for (const apiBase of ['https://example.com', 'http://api.individual.githubcopilot.com', 'https://api.individual.githubcopilot.com.evil.test'])
    expect(() => copilotBase({ ...grant, subscriptionAuth: { apiBase } })).toThrow('Invalid Copilot API origin')
})

it('presents the VS Code Copilot Chat client with stable per-account and per-conversation identity', () => {
  const headers = copilotHeaders(grant, 'agent', 'session-1')
  expect(headers).toMatchObject({
    authorization: 'Bearer copilot-token',
    'copilot-integration-id': 'vscode-chat',
    'editor-version': 'vscode/1.144.0',
    'editor-plugin-version': 'copilot-chat/0.72.0',
    'user-agent': 'GitHubCopilotChat/0.72.0',
    'x-github-api-version': '2025-05-01',
    'x-initiator': 'agent',
    'openai-intent': 'conversation-panel',
  })
  expect(headers['vscode-machineid']).toMatch(/^[0-9a-f]{64}$/)
  expect(headers['vscode-sessionid']).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\d{13}$/)
  expect(headers['x-interaction-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const again = copilotHeaders(grant, 'user', 'session-1')
  expect(again['x-initiator']).toBe('user')
  expect(again['x-request-id']).not.toBe(headers['x-request-id'])
  for (const name of ['vscode-machineid', 'vscode-sessionid', 'x-interaction-id'])
    expect(again[name]).toBe(headers[name])
  // A different conversation changes the session but not the install; a different account changes both.
  const other = copilotHeaders(grant, 'user', 'session-2')
  expect(other['vscode-machineid']).toBe(headers['vscode-machineid'])
  expect(other['x-interaction-id']).not.toBe(headers['x-interaction-id'])
  expect(copilotHeaders({ ...grant, refreshToken: 'someone-else' })['vscode-machineid']).not.toBe(headers['vscode-machineid'])
  expect(copilotHeaders({ ...grant, refreshToken: '' })).toMatchObject({ 'x-initiator': 'user' })
  expect(JSON.stringify(headers)).not.toContain('github-token')
})

it('recognizes quota exhaustion by status or by the error codes VS Code treats as quota', () => {
  expect(isCopilotQuotaFailure(402, 'anything')).toBe(true)
  for (const body of [{ error: { code: 'quota_exceeded' } }, { code: 'free_quota_exceeded' }, { error: { code: 'overage_limit_reached:premium' } },
    { error: { code: 'billing_not_configured' } }, { code: 'additional_spend_limit_reached' }])
    expect(isCopilotQuotaFailure(429, JSON.stringify(body)), JSON.stringify(body)).toBe(true)
  expect(isCopilotQuotaFailure(401, JSON.stringify({ code: 'quota_exceeded' }))).toBe(false)
  expect(isCopilotQuotaFailure(200, JSON.stringify({ code: 'quota_exceeded' }))).toBe(false)
  for (const body of ['not json', '[]', '"quota_exceeded"', '{}', JSON.stringify({ error: { code: 'model_not_supported' } }), JSON.stringify({ error: { code: 7 } })])
    expect(isCopilotQuotaFailure(400, body), body).toBe(false)
})

it('parses quota snapshot headers', () => {
  expect(parseCopilotQuotaSnapshot(null)).toBeNull()
  expect(parseCopilotQuotaSnapshot('')).toBeNull()
  expect(parseCopilotQuotaSnapshot(snapshot({ ent: '300' }))).toBeNull()
  expect(parseCopilotQuotaSnapshot(snapshot({ ent: '300', rem: '12.5', ovPerm: 'true', rst: '2026-12-01T00:00:00Z' }))).toEqual({
    entitlement: 300, percentRemaining: 12.5, overagePermitted: true, resetAt: Date.parse('2026-12-01T00:00:00Z'),
  })
  expect(parseCopilotQuotaSnapshot('rem=5')).toEqual({ entitlement: 0, percentRemaining: 5, overagePermitted: false })
  expect(parseCopilotQuotaSnapshot(snapshot({ rem: '0', ent: 'many', rst: 'soon' }))).toEqual({ entitlement: 0, percentRemaining: 0, overagePermitted: false })
})

const quota = (status: number, headers: Record<string, string> = {}, body: unknown = { error: { code: 'quota_exceeded' } }) =>
  new Response(JSON.stringify(body), { status, statusText: 'Payment Required', headers })

it('attaches the real reset to quota failures, preferring the exhausted window over the account lookup', async () => {
  const lookup = vi.fn(() => Promise.reject(new Error('should not look up')))
  vi.stubGlobal('fetch', lookup)
  const reset = new Date(now + 3 * 86_400_000).toISOString()
  const windows = {
    'x-quota-snapshot-premium_interactions': snapshot({ rem: '0', ent: '300', rst: reset }),
    'x-quota-snapshot-chat': snapshot({ rem: '0', ent: '300', rst: new Date(now + 86_400_000).toISOString() }),
    // Not exhausted, overage permitted, past, or unparseable windows are ignored.
    'x-quota-snapshot-premium_models': snapshot({ rem: '40', rst: reset }),
    'x-usage-ratelimit-session': snapshot({ rem: '0', ovPerm: 'true', rst: reset }),
    'x-usage-ratelimit-weekly': snapshot({ rem: '0', rst: new Date(now - 1000).toISOString() }),
  }
  const response = await annotateQuotaFailure(quota(402, windows), grant, undefined, now)
  expect(response.status).toBe(429)
  expect(response.statusText).toBe('')
  expect(response.headers.get('retry-after')).toBe(String(3 * 86_400))
  expect(await response.json()).toEqual({ error: { code: 'quota_exceeded' } })
  expect(lookup).not.toHaveBeenCalled()
  // An upstream Retry-After always wins, and a 429 keeps its status text.
  const kept = await annotateQuotaFailure(quota(429, { 'retry-after': '12' }), grant, undefined, now)
  expect(kept.headers.get('retry-after')).toBe('12')
  expect(kept.status).toBe(429)
  expect(kept.statusText).toBe('Payment Required')
  expect(lookup).not.toHaveBeenCalled()
})

it('asks the account for its reset date, then falls back to the next UTC month', async () => {
  const nextMonth = String(Math.ceil((Date.UTC(2026, 11, 1) - now) / 1000))
  const seen: Request[] = []
  const answer = (value: () => Response | Promise<Response>) => vi.stubGlobal('fetch', vi.fn((input: string, init: RequestInit) => {
    seen.push(new Request(input, init))
    return Promise.resolve().then(value)
  }))
  answer(() => Response.json({ quota_reset_date_utc: new Date(now + 5 * 86_400_000).toISOString() }))
  expect((await annotateQuotaFailure(quota(402), grant, undefined, now)).headers.get('retry-after')).toBe(String(5 * 86_400))
  expect(seen[0]?.url).toBe('https://api.github.com/copilot_internal/user')
  expect(seen[0]?.headers.get('authorization')).toBe('token github-token')
  expect(seen[0]?.headers.get('x-github-api-version')).toBe('2025-04-01')
  expect(seen[0]?.headers.get('editor-version')).toBe('vscode/1.144.0')
  answer(() => Response.json({ quota_reset_date: new Date(now + 2 * 86_400_000).toISOString() }))
  expect((await annotateQuotaFailure(quota(402), grant, undefined, now)).headers.get('retry-after')).toBe(String(2 * 86_400))
  for (const lookup of [
    () => new Response('no', { status: 500 }),
    () => { throw new Error('offline') },
    () => Response.json({}),
    () => Response.json({ quota_reset_date_utc: new Date(now - 1000).toISOString() }),
    () => Response.json({ quota_reset_date_utc: 7 }),
  ]) {
    answer(lookup)
    expect((await annotateQuotaFailure(quota(402), grant, undefined, now)).headers.get('retry-after')).toBe(nextMonth)
  }
  // Without a GitHub token there is nothing to look up with.
  seen.length = 0
  answer(() => Response.json({}))
  expect((await annotateQuotaFailure(quota(402), { ...grant, refreshToken: '' }, undefined, now)).headers.get('retry-after')).toBe(nextMonth)
  expect(seen).toEqual([])
})

it('passes every other response through unchanged', async () => {
  const ok = new Response('ok')
  expect(await annotateQuotaFailure(ok, grant)).toBe(ok)
  const bad = await annotateQuotaFailure(new Response('{"error":{"code":"model_not_supported"}}', { status: 400, statusText: 'Bad Request' }), grant, undefined, now)
  expect(bad.status).toBe(400)
  expect(bad.statusText).toBe('Bad Request')
  expect(bad.headers.get('retry-after')).toBeNull()
  expect(await bad.text()).toBe('{"error":{"code":"model_not_supported"}}')
  expect((await annotateQuotaFailure(new Response('', { status: 401 }), grant)).status).toBe(401)
})

it('posts chat completions to the account origin with Copilot identity', async () => {
  const seen: Request[] = []
  vi.stubGlobal('fetch', vi.fn((input: string, init: RequestInit) => {
    seen.push(new Request(input, init))
    return Promise.resolve(quota(402, { 'retry-after': '30' }))
  }))
  const response = await callCopilot(grant, { model: 'gpt-4.1', messages: [] }, { initiator: 'agent', session: 'abc', signal: AbortSignal.timeout(1000) })
  expect(response.status).toBe(429)
  expect(seen[0]?.url).toBe('https://api.business.githubcopilot.com/chat/completions')
  expect(seen[0]?.method).toBe('POST')
  expect(seen[0]?.headers.get('x-initiator')).toBe('agent')
  expect(await seen[0]?.json()).toEqual({ model: 'gpt-4.1', messages: [] })
  await callCopilot(grant, {}, { initiator: 'user', signal: AbortSignal.timeout(1000) })
  expect(seen[1]?.headers.get('x-initiator')).toBe('user')
})
