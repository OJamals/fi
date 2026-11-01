/** Native subscription grant validation and bounded HTTP operations. */
import { z } from 'zod'

/** Providers served by the native subscription adapter. */
export const providerIds = ['copilot', 'cursor', 'kiro', 'cline', 'gemini-cli'] as const
/** Provider identity used by authorization and inference. */
export type SubscriptionId = (typeof providerIds)[number]
/** Canonical stored subscription grant. */
export const grantSchema = z.object({
  provider: z.enum(providerIds),
  accessToken: z.string().min(1),
  refreshToken: z.string(),
  expiresAt: z.iso.datetime(),
  subscriptionAuth: z
    .object({
      machineId: z.string().optional(),
      region: z.string().optional(),
      profileArn: z.string().optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      projectId: z.string().optional(),
      apiBase: z.string().optional(),
    })
    .optional(),
})
/** Durable grant fields validated on every credential read. */
export type SubscriptionGrant = z.infer<typeof grantSchema>
/** Non-secret deployment settings for authorization, catalogs, and inference. */
export interface SubscriptionOptions {
  /** Maximum milliseconds for catalog and non-streaming HTTP operations. */
  requestTimeoutMs: number
  /** Maximum idle milliseconds between streamed events. */
  streamIdleTimeoutMs: number
  /** Maximum milliseconds for browser or device authorization. */
  authTimeoutMs: number
  /** Delay in milliseconds between authorization or onboarding polls. */
  pollIntervalMs: number
  /** Refresh access tokens this many milliseconds before expiry. */
  refreshMarginMs: number
  /** Context capacity when the provider catalog omits it. */
  defaultContextWindow: number
  /** Default output token cap. */
  defaultMaxTokens: number
  /** AWS region for Kiro device authorization and inference. */
  kiroRegion: string
  /** Optional entitled Google Cloud project id. */
  geminiProjectId: string
  /** Public installed-app Google OAuth client id. */
  geminiClientId: string
  /** Public installed-app Google OAuth client secret. */
  geminiClientSecret: string
  /** Loopback port for the state-checked Google OAuth callback. */
  geminiCallbackPort: number
}
/** Context consumed by the auth2api native protocol translation, without a proxy server. */
export interface NativeCallContext {
  body: unknown
  account: { token: SubscriptionGrant }
  config: { timeouts: { 'messages-ms': number; 'stream-messages-ms': number } }
  signal?: AbortSignal
}
/** OpenAI text and function-tool fields accepted by the native encoders. */
export const nativeRequestSchema = z
  .object({
    model: z.string().min(1),
    stream: z.boolean().optional(),
    messages: z
      .array(
        z.object({
          role: z.string(),
          content: z.unknown().optional(),
          tool_call_id: z.string().optional(),
          is_error: z.boolean().optional(),
          tool_calls: z
            .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .optional(),
        }),
      )
      .default([]),
    tools: z
      .array(
        z.object({
          type: z.literal('function'),
          function: z.object({
            name: z.string(),
            description: z.string().optional(),
            parameters: z.record(z.string(), z.unknown()).optional(),
          }),
        }),
      )
      .default([]),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    reasoning_effort: z.string().optional(),
  })
  .loose()
/** Validated request fields at the native wire parser. */
export type NativeRequest = z.infer<typeof nativeRequestSchema>
/**
 * Combine a deployment deadline and operation cancellation.
 * @param ms - deadline in milliseconds.
 * @param signal - caller cancellation.
 * @returns shared abort signal.
 */
export function withTimeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])])
}
/**
 * Read a Retry-After header as a delay.
 * @param value - delta seconds or an HTTP date.
 * @param now - current epoch milliseconds.
 * @returns a positive delay in milliseconds, or undefined when absent or unusable.
 */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) && delay > 0 ? Math.ceil(delay) : undefined
}

/**
 * Validate a Kiro region before constructing AWS hosts.
 * @param auth - current account's region.
 * @returns validated region.
 */
export function kiroRegion(auth?: SubscriptionGrant['subscriptionAuth']): string {
  const region = auth?.region ?? 'us-east-1'
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error('Invalid Kiro region')
  return region
}
/**
 * Read a JSON response without exposing provider error bodies or following redirects.
 * @param url - trusted provider endpoint.
 * @param config - operation deadline.
 * @param init - caller headers, body, and cancellation.
 * @returns untrusted response data for the owning schema.
 */
export async function json(url: string, config: SubscriptionOptions, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers)
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  headers.set('accept', 'application/json')
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    headers,
    signal: withTimeoutSignal(config.requestTimeoutMs, init.signal ?? undefined),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Subscription endpoint failed (${response.status})`)
  }
  return response.json()
}
/**
 * Identify Cline requests truthfully, including its required client headers.
 * @param token - account API key.
 * @returns headers for the fixed Cline API origin.
 */
export function clineHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': 'fi/0.2.0',
    'x-client-type': 'fi',
    'x-client-version': '0.2.0',
    'x-title': 'Fi',
  }
}
