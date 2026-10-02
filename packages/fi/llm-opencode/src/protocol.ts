/** OpenCode Console JSON validation, endpoint admission, and bounded requests. */
import { z } from 'zod'

/** Non-secret deployment settings frozen for one authorization or model operation. */
export interface ConsoleOptions {
  /** HTTPS Console server without query parameters or embedded credentials. */
  server: string
  /** Public device-authorization client id. */
  clientId: string
  /** Reviewed OpenCode compatibility identity sent on Console and inference requests. */
  userAgent: string
  /** Maximum duration of a Console request or provider response-header wait, in milliseconds. */
  requestTimeoutMs: number
  /** Maximum silence between provider stream events, in milliseconds. */
  streamIdleTimeoutMs: number
  /** Rotate tokens this many milliseconds before their expiration. */
  refreshMarginMs: number
  /** Context capacity when the authenticated catalog omits it. */
  defaultContextWindow: number
  /** Output capacity when the authenticated catalog omits it. */
  defaultMaxTokens: number
}

/** Console token fields, including the organization selected in the browser. */
export const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().max(31_536_000),
  org_id: z.string().min(1).nullable().optional(),
})

/** Grant stored only in FI's canonical credential store. */
export const grantSchema = z.object({
  type: z.literal('oauth'),
  server: z.string(),
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number(),
  email: z.string(),
  accountId: z.string().min(1),
  orgId: z.string().min(1).optional(),
  orgName: z.string().optional(),
})

/** Validated persisted Console grant. */
export type ConsoleGrant = z.infer<typeof grantSchema>

/**
 * Admit only HTTPS OpenCode endpoints without embedded credentials or URL overrides.
 * @param value - configured or advertised endpoint.
 * @returns normalized endpoint, without a trailing slash.
 */
export function consoleUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || (url.hostname !== 'opencode.ai' && !url.hostname.endsWith('.opencode.ai'))
    || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('OpenCode endpoint must be an HTTPS opencode.ai URL')
  }
  return url.href.replace(/\/+$/, '')
}

/**
 * Fetch and validate one Console JSON response within the operation deadline.
 * @param options - frozen endpoint and request timeout.
 * @param path - fixed Console-relative API path.
 * @param init - request body, authentication, and caller cancellation.
 * @returns parsed JSON; unsuccessful responses expose only status and known auth recovery instructions.
 */
export async function consoleJson(options: ConsoleOptions, path: string, init: RequestInit): Promise<unknown> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.requestTimeoutMs),
    ...(init.signal == null ? [] : [init.signal]),
  ])
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  headers.set('user-agent', options.userAgent)
  const response = await fetch(`${consoleUrl(options.server)}${path}`, {
    ...init,
    signal,
    redirect: 'error',
    headers,
  })
  const data: unknown = await response.json()
  signal.throwIfAborted()
  if (!response.ok) {
    const auth = z.object({ _tag: z.string().optional(), error: z.string().optional() }).safeParse(data)
    if (auth.success && auth.data._tag === 'SsoRequired') throw new Error('OpenCode organization requires SSO; reconnect OpenCode Console')
    if (response.status === 401 || (auth.success && auth.data.error === 'invalid_grant')) {
      throw new Error('OpenCode grant expired or was revoked; reconnect OpenCode Console')
    }
    throw new Error(`OpenCode Console request failed (${response.status})`)
  }
  return data
}

/**
 * Read a token response while retaining only validated protocol fields.
 * @param options - frozen Console settings.
 * @param body - device or refresh grant request.
 * @param signal - caller cancellation.
 * @returns validated token response.
 */
export async function exchangeToken(
  options: ConsoleOptions, body: Record<string, string>, signal?: AbortSignal,
): Promise<z.infer<typeof tokenSchema>> {
  return tokenSchema.parse(await consoleJson(options, '/auth/device/token', {
    method: 'POST', body: JSON.stringify({ ...body, client_id: options.clientId }),
    ...signal === undefined ? {} : { signal },
  }))
}
