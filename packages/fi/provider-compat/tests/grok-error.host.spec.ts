import { describe, expect, it, vi } from 'vitest'
import { normalizeGrokError } from '../src/grok-error.ts'
import { subscriptionFetch } from '../src/index.ts'

function failure(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, statusText: 'Failure', headers })
}

describe('xAI error normalization', () => {
  it.each([
    [401, 'authentication_error'],
    [402, 'billing_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [413, 'request_too_large'],
    [429, 'rate_limit_error'],
    [400, 'invalid_request_error'],
    [503, 'api_error'],
  ])('restates a %i failure with the %s type', async (status, type) => {
    const response = await normalizeGrokError(failure(
      JSON.stringify({ code: 'The caller does not have permission', error: 'Quota exceeded for model grok-4.3' }),
      status,
      { 'content-type': 'text/plain', 'content-length': '999', 'retry-after': '30', 'x-request-id': 'req' },
    ))
    expect(response.status).toBe(status)
    expect(response.statusText).toBe('Failure')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('retry-after')).toBe('30')
    expect(response.headers.get('x-request-id')).toBe('req')
    expect(await response.json()).toEqual({
      error: { message: 'Quota exceeded for model grok-4.3', type, code: 'The caller does not have permission' },
    })
  })

  it('omits an absent code, redacts API keys, and bounds and defaults the message', async () => {
    const withoutCode = await normalizeGrokError(failure(JSON.stringify({ error: 'Key xai-abcdefghijklmnop is invalid' }), 400))
    expect(await withoutCode.json()).toEqual({ error: { message: 'Key <redacted> is invalid', type: 'invalid_request_error' } })
    const emptyCode = await normalizeGrokError(failure(JSON.stringify({ code: '', error: 'x'.repeat(2000) }), 400))
    const bounded = await emptyCode.json() as { error: { message: string; code?: string } }
    expect(bounded.error.message).toHaveLength(1000)
    expect(bounded.error).not.toHaveProperty('code')
    const blank = await normalizeGrokError(failure(JSON.stringify({ code: 7, error: '' }), 500))
    expect(await blank.json()).toEqual({ error: { message: 'Upstream request failed', type: 'api_error' } })
  })

  it('returns successes and other failure bodies as the same unread response', async () => {
    const ok = new Response('{"error":"not an error"}')
    expect(await normalizeGrokError(ok)).toBe(ok)
    for (const body of [JSON.stringify({ error: { message: 'object form', type: 'invalid_request_error' } }), 'upstream gateway timeout', 'null', '']) {
      const response = failure(body, 502)
      const normalized = await normalizeGrokError(response)
      expect(normalized).toBe(response)
      expect(await normalized.text()).toBe(body)
    }
  })

  it('normalizes only Grok failures delivered through the subscription fetch', async () => {
    const grok = `header.${Buffer.from(JSON.stringify({ sub: 'user' })).toString('base64url')}.signature`
    const delegate = vi.fn<typeof globalThis.fetch>()
    delegate.mockResolvedValueOnce(failure(JSON.stringify({ code: 'slug', error: 'Rate limited' }), 429))
    const fetch = subscriptionFetch({ provider: 'xai', model: 'grok', timeoutMs: 1000, harnessUserAgent: 'harness' }, delegate)
    const response = await fetch('https://api.x.ai/v1/responses', { headers: { Authorization: `Bearer ${grok}` } })
    expect(await response.json()).toEqual({ error: { message: 'Rate limited', type: 'rate_limit_error', code: 'slug' } })

    const claude = failure(JSON.stringify({ type: 'error', error: 'kept as sent' }), 429)
    delegate.mockResolvedValueOnce(claude)
    const anthropic = subscriptionFetch({ provider: 'anthropic', model: 'claude', timeoutMs: 1000, harnessUserAgent: 'harness' }, delegate)
    expect(await anthropic('https://api.anthropic.com/v1/messages', { headers: { Authorization: 'Bearer sk-ant-oat-test' } })).toBe(claude)
  })
})
