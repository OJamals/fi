/**
 * Retry hints carried by Cloud Code failures.
 *
 * A 429 or 503 from Cloud Code names when the caller may try again: a
 * `Retry-After` header, a Google `RetryInfo` detail, or an `ErrorInfo` quota
 * reset. Google error text can echo the rejected request, so nothing from the
 * body survives except that delay, handed on as `Retry-After`; the diagnostics
 * stay status-only.
 *
 * @module @fi/llm-antigravity/failure-hints
 */

/** Statuses whose Google error bodies carry RetryInfo or quota reset details. */
const HINT_STATUSES: ReadonlySet<number> = new Set([429, 503])
const MAX_ERROR_BODY_BYTES = 64 * 1024
const ERROR_BODY_READ_MS = 2_000
const DURATION_UNIT = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi
const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }

function ignore(): void {}

/**
 * Parse a protobuf-style duration such as `53s`, `1.5s`, or `1h2m3s`.
 * @param value - duration text.
 * @returns whole milliseconds, or `undefined` when any part of the text is not a duration.
 */
function parseDuration(value: string): number | undefined {
  let total = 0
  let consumed = 0
  for (const match of value.matchAll(DURATION_UNIT)) {
    if (match.index !== consumed) return undefined
    total += Number(match[1]) * (UNIT_MS[(match[2] as string).toLowerCase()] as number)
    consumed += match[0].length
  }
  return consumed === value.length && consumed > 0 ? Math.ceil(total) : undefined
}

function headerDelayMs(headers: Headers, now: number): number | undefined {
  const value = headers.get('retry-after')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field.trim() : undefined
}

function bodyDelaysMs(body: string, now: number): number[] {
  let error: unknown
  try {
    error = (JSON.parse(body) as { error?: unknown } | null)?.error
  } catch {
    return []
  }
  const details = (error as { details?: unknown } | null | undefined)?.details
  const delays: Array<number | undefined> = []
  for (const detail of Array.isArray(details) ? details : []) {
    const type = stringField(detail, '@type') ?? ''
    if (type.endsWith('google.rpc.RetryInfo')) {
      delays.push(parseDuration(stringField(detail, 'retryDelay') ?? ''))
    } else if (type.endsWith('google.rpc.ErrorInfo')) {
      const metadata = (detail as { metadata?: unknown }).metadata
      delays.push(parseDuration(stringField(metadata, 'quotaResetDelay') ?? ''))
      const resetAt = Date.parse(stringField(metadata, 'quotaResetTimeStamp') ?? '')
      delays.push(resetAt > now ? resetAt - now : undefined)
    }
  }
  return delays.filter((delay): delay is number => delay !== undefined)
}

/**
 * Read how long a Cloud Code failure asks the caller to wait.
 * @param headers - failure response headers.
 * @param body - failure body text; anything that is not a Google error envelope is ignored.
 * @param now - epoch milliseconds that date and timestamp hints are measured from.
 * @returns the longest hinted delay in milliseconds, or `undefined` when there is none.
 */
export function cloudCodeRetryDelayMs(headers: Headers, body: string, now = Date.now()): number | undefined {
  const delays = [headerDelayMs(headers, now), ...bodyDelaysMs(body, now)]
    .filter((delay): delay is number => delay !== undefined)
  return delays.length > 0 ? Math.max(...delays) : undefined
}

async function readErrorBody(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder()
  let body = ''
  // Cancelling the reader settles a pending read, which bounds a slow body.
  const deadline = setTimeout(() => { void reader.cancel().catch(ignore) }, ERROR_BODY_READ_MS)
  try {
    for (let total = 0; total < MAX_ERROR_BODY_BYTES;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      body += decoder.decode(chunk.value, { stream: true })
    }
  } catch {
    body = ''
  } finally {
    clearTimeout(deadline)
    await reader.cancel().catch(ignore)
  }
  return body
}

/**
 * Headers for a sanitized Cloud Code failure: the response's own retry hint
 * as `Retry-After` seconds. Only 429 and 503 bodies are read, and only for
 * that hint; every other body is discarded unread.
 * @param upstream - the failed upstream response; its body is consumed.
 * @param headers - headers to extend, for callers that already carry some.
 * @returns `headers`, with `Retry-After` set when the failure hinted a delay.
 */
export async function cloudCodeFailureHeaders(
  upstream: Response,
  headers: Headers = new Headers(),
): Promise<Headers> {
  const hinted = HINT_STATUSES.has(upstream.status)
  const body = hinted ? await readErrorBody(upstream) : ''
  if (!hinted) await upstream.body?.cancel().catch(ignore)
  const delay = cloudCodeRetryDelayMs(upstream.headers, body)
  if (delay !== undefined && delay > 0) headers.set('Retry-After', String(Math.ceil(delay / 1_000)))
  return headers
}
