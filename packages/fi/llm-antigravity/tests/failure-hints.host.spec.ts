/** Cloud Code failures expose their retry hint and nothing else from the body. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudCodeFailureHeaders, cloudCodeRetryDelayMs } from '../src/failure-hints.ts'

const NOW = Date.parse('2026-11-01T10:00:00Z')

function googleError(...details: unknown[]): string {
  return JSON.stringify({ error: { code: 429, message: 'secret prompt echo', details } })
}

const retryInfo = (retryDelay: unknown) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay })
const errorInfo = (metadata: unknown) => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', metadata })

afterEach(() => { vi.useRealTimers() })

describe('cloudCodeRetryDelayMs', () => {
  it.each([
    ['53s', 53_000],
    ['1.5s', 1_500],
    ['250ms', 250],
    ['2m', 120_000],
    ['1h2m3s', 3_723_000],
    ['1H', 3_600_000],
  ])('reads RetryInfo %s as %i ms', (retryDelay, expected) => {
    expect(cloudCodeRetryDelayMs(new Headers(), googleError(retryInfo(retryDelay)), NOW)).toBe(expected)
  })

  it.each(['', 'soon', '5', '5x', '1s junk', '1s 2s', 7, undefined])('ignores unusable RetryInfo delay %j', (retryDelay) => {
    expect(cloudCodeRetryDelayMs(new Headers(), googleError(retryInfo(retryDelay)), NOW)).toBeUndefined()
  })

  it('reads ErrorInfo quota reset delays and future timestamps, ignoring past and malformed ones', () => {
    expect(cloudCodeRetryDelayMs(new Headers(), googleError(errorInfo({ quotaResetDelay: '46h13m39.1s' })), NOW))
      .toBe(166_419_100)
    expect(cloudCodeRetryDelayMs(new Headers(), googleError(errorInfo({ quotaResetTimeStamp: '2026-11-01T10:00:30Z' })), NOW))
      .toBe(30_000)
    for (const metadata of [{ quotaResetTimeStamp: '2026-11-01T09:00:00Z' }, { quotaResetTimeStamp: 'never' }, {}, null, 'x']) {
      expect(cloudCodeRetryDelayMs(new Headers(), googleError(errorInfo(metadata)), NOW)).toBeUndefined()
    }
  })

  it('takes the longest hint across the header and every detail', () => {
    const body = googleError(
      retryInfo('10s'),
      errorInfo({ quotaResetDelay: '90s', quotaResetTimeStamp: '2026-11-01T10:00:30Z' }),
    )
    expect(cloudCodeRetryDelayMs(new Headers({ 'retry-after': '20' }), body, NOW)).toBe(90_000)
    expect(cloudCodeRetryDelayMs(new Headers({ 'retry-after': '120' }), body, NOW)).toBe(120_000)
  })

  it('reads Retry-After seconds and dates, and ignores junk', () => {
    expect(cloudCodeRetryDelayMs(new Headers({ 'retry-after': ' 2.5 ' }), '', NOW)).toBe(2_500)
    expect(cloudCodeRetryDelayMs(new Headers({ 'retry-after': 'Sun, 01 Nov 2026 10:01:00 GMT' }), '', NOW)).toBe(60_000)
    expect(cloudCodeRetryDelayMs(new Headers({ 'retry-after': 'Sun, 01 Nov 2026 09:00:00 GMT' }), '', NOW)).toBe(0)
    for (const value of ['', '   ', 'later']) {
      expect(cloudCodeRetryDelayMs(new Headers({ 'retry-after': value }), '', NOW)).toBeUndefined()
    }
    // A negative number is not a delay; whatever date it parses to is long past.
    expect(cloudCodeRetryDelayMs(new Headers({ 'retry-after': '-4' }), '', NOW)).toBe(0)
    expect(cloudCodeRetryDelayMs(new Headers(), '', NOW)).toBeUndefined()
  })

  it.each([
    'not json',
    'null',
    '"text"',
    '{}',
    '{"error":"text"}',
    '{"error":{"details":"text"}}',
    '{"error":{"details":[null,7,{},{"@type":7},{"@type":"other.Type","retryDelay":"5s"}]}}',
  ])('ignores a body that is not a Google retry detail: %s', (body) => {
    expect(cloudCodeRetryDelayMs(new Headers(), body, NOW)).toBeUndefined()
  })

  it('measures from the current time by default', () => {
    expect(cloudCodeRetryDelayMs(new Headers({ 'retry-after': '3' }), '')).toBe(3_000)
  })
})

describe('cloudCodeFailureHeaders', () => {
  it('turns a 429 RetryInfo into whole Retry-After seconds without exposing the body', async () => {
    const headers = await cloudCodeFailureHeaders(new Response(googleError(retryInfo('1.2s')), { status: 429 }))
    expect(headers.get('retry-after')).toBe('2')
    expect([...headers.keys()]).toEqual(['retry-after'])
  })

  it('reads a 503 the same way and extends the headers it is given', async () => {
    const own = new Headers({ 'X-Upstream-Request-ID': 'req-1' })
    const headers = await cloudCodeFailureHeaders(new Response(googleError(retryInfo('30s')), { status: 503 }), own)
    expect(headers).toBe(own)
    expect(headers.get('x-upstream-request-id')).toBe('req-1')
    expect(headers.get('retry-after')).toBe('30')
  })

  it.each([
    [429, googleError(retryInfo('0s'))],
    [429, 'plain text'],
    [503, ''],
  ])('sets nothing when status %i names no positive delay', async (status, body) => {
    expect((await cloudCodeFailureHeaders(new Response(body, { status }))).has('retry-after')).toBe(false)
  })

  it('keeps a header hint on any status but discards that body unread', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    const headers = await cloudCodeFailureHeaders(new Response(body, { status: 500, headers: { 'retry-after': '7' } }))
    expect(headers.get('retry-after')).toBe('7')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not read a body that was never sent', async () => {
    expect((await cloudCodeFailureHeaders(new Response(null, { status: 429 }))).has('retry-after')).toBe(false)
    expect((await cloudCodeFailureHeaders(new Response(null, { status: 404 }))).has('retry-after')).toBe(false)
  })

  it('drops a body that fails mid-read', async () => {
    const body = new ReadableStream({
      start(controller) { controller.error(new Error('reset')) },
    })
    const headers = await cloudCodeFailureHeaders(new Response(body, { status: 429, headers: { 'retry-after': '4' } }))
    expect(headers.get('retry-after')).toBe('4')
  })

  it('stops reading at the size ceiling', async () => {
    const chunk = new Uint8Array(40 * 1024).fill(32)
    const pulls = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls()
        controller.enqueue(chunk)
      },
    })
    await cloudCodeFailureHeaders(new Response(body, { status: 429 }))
    expect(pulls.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('bounds a slow body with a deadline and tolerates a failing cancel', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(() => { throw new Error('cancel failure') })
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(googleError(retryInfo('9s'))).slice(0, 12)) },
      cancel,
    })
    const pending = cloudCodeFailureHeaders(new Response(body, { status: 429 }))
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await pending).has('retry-after')).toBe(false)
    expect(cancel).toHaveBeenCalledOnce()
  })
})
