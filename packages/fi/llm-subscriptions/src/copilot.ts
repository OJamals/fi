/** Copilot chat transport; pi-ai retains ownership of device login and token refresh. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { withTimeoutSignal } from './protocol.ts'
import type { SubscriptionGrant } from './protocol.ts'

// Native identity of the GitHub Copilot Chat client, verified 2026-11-01:
// - VS Code 1.144.0 is the latest stable release (published 2026-10-28).
// - The chat extension ships inside that tree: extensions/copilot/package.json at tag 1.144.0
//   has version 0.72.0. The standalone vscode-copilot-chat repository was archived on
//   2026-05-20, so it no longer tracks the real client.
// - Header names and values: extensions/copilot chatMLFetcher.ts (X-Request-Id,
//   X-Interaction-Id, X-Initiator, X-GitHub-Api-Version 2025-05-01) and the @vscode/copilot-api
//   client (Editor-Version, Editor-Plugin-Version, VScode-SessionId, VScode-MachineId).
const COPILOT_EDITOR_VERSION = 'vscode/1.144.0'
const COPILOT_PLUGIN_VERSION = 'copilot-chat/0.72.0'
const COPILOT_USER_AGENT = 'GitHubCopilotChat/0.72.0'
/** Chat endpoints; the token exchange and copilot_internal/user keep 2025-04-01. */
const COPILOT_CHAT_API_VERSION = '2025-05-01'
const COPILOT_TOKEN_API_VERSION = '2025-04-01'
/** Process start: the VS Code session ID is `<uuid><epoch ms>` fixed per window launch. */
const PROCESS_START_MS = Date.now()

/**
 * Constrain credentials to GitHub's account-specific inference hosts.
 * @param grant - resolved Copilot subscription credential.
 * @returns validated API origin.
 */
export function copilotBase(grant: SubscriptionGrant): string {
  const base = grant.subscriptionAuth?.apiBase ?? 'https://api.individual.githubcopilot.com'
  if (!/^https:\/\/api\.(?:individual|business|enterprise)\.githubcopilot\.com$/.test(base))
    throw new Error('Invalid Copilot API origin')
  return base
}

/** Deterministic UUID-shaped identifier; the same inputs always give the same value. */
function stableUuid(...parts: string[]): string {
  const hex = createHash('sha256').update(['fi:copilot', ...parts].join('\0')).digest('hex')
  const variant = (Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant.toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

/** Headers shared by every Copilot call, including the GitHub token lookup. */
function copilotClientHeaders(): Record<string, string> {
  return {
    'editor-version': COPILOT_EDITOR_VERSION,
    'editor-plugin-version': COPILOT_PLUGIN_VERSION,
    'user-agent': COPILOT_USER_AGENT,
  }
}

/**
 * Supply Copilot's required chat integration headers. Session and interaction ids are
 * stable for one account and conversation, so an agent loop looks like one editor session
 * rather than a new client on every request; `vscode.env.machineId` is a 64-character
 * SHA-256 hex digest, stable per install.
 * @param grant - resolved Copilot subscription credential; `refreshToken` carries the GitHub account token.
 * @param initiator - whether the current request starts with user input or continues a tool round.
 * @param session - durable conversation id; requests without one share the account's default session.
 * @returns headers for the validated Copilot origin.
 */
export function copilotHeaders(
  grant: SubscriptionGrant,
  initiator: 'user' | 'agent' = 'user',
  session = 'default',
): Record<string, string> {
  const account = grant.refreshToken || 'copilot'
  return {
    authorization: `Bearer ${grant.accessToken}`,
    'content-type': 'application/json',
    'copilot-integration-id': 'vscode-chat',
    ...copilotClientHeaders(),
    'openai-intent': 'conversation-panel',
    'x-github-api-version': COPILOT_CHAT_API_VERSION,
    'x-request-id': randomUUID(),
    'x-initiator': initiator,
    'vscode-sessionid': `${stableUuid('session', account, session)}${PROCESS_START_MS}`,
    'vscode-machineid': createHash('sha256').update(`fi:copilot:machine\0${account}`).digest('hex'),
    'x-interaction-id': stableUuid('interaction', account, session),
  }
}

// -- Premium quota -----------------------------------------------------------

/**
 * Error codes after which VS Code treats the request as quota-exhausted
 * (extensions/copilot chatMLFetcher.isQuotaExceededErrorCode). HTTP 402 is the same
 * condition on the plain HTTP path.
 */
const QUOTA_CODES: ReadonlySet<string> = new Set([
  'quota_exceeded',
  'free_quota_exceeded',
  'overage_limit_reached',
  'billing_not_configured',
  'additional_spend_limit_reached',
])

const failureBody = z.object({
  code: z.string().optional(),
  error: z.object({ code: z.string().optional() }).optional(),
})

/**
 * Decide whether a rejected request is quota exhaustion.
 * @param status - HTTP status.
 * @param body - response text, possibly JSON with an error code.
 * @returns true for HTTP 402 or a VS Code quota error code.
 */
export function isCopilotQuotaFailure(status: number, body: string): boolean {
  if (status === 402) return true
  if (status < 400 || status === 401) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (_notJson) {
    return false
  }
  const failure = failureBody.safeParse(parsed).data
  const code = failure?.error?.code ?? failure?.code
  return code !== undefined && QUOTA_CODES.has(code.replace(/:.*$/s, ''))
}

/** `x-quota-snapshot-*` and `x-usage-ratelimit-*` values are URL-encoded pairs. */
export interface CopilotQuotaSnapshot {
  entitlement: number
  percentRemaining: number
  overagePermitted: boolean
  resetAt?: number
}

/**
 * Parse one quota snapshot header.
 * @param value - URL-encoded `ent`, `rem`, `ovPerm`, `rst` pairs.
 * @returns the snapshot, or null when the header is absent or has no remaining percentage.
 */
export function parseCopilotQuotaSnapshot(value: string | null): CopilotQuotaSnapshot | null {
  if (!value) return null
  const params = new URLSearchParams(value)
  const percentRemaining = Number.parseFloat(params.get('rem') ?? '')
  if (!Number.isFinite(percentRemaining)) return null
  const reset = Date.parse(params.get('rst') ?? '')
  return {
    entitlement: Number.parseInt(params.get('ent') ?? '0', 10) || 0,
    percentRemaining,
    overagePermitted: params.get('ovPerm') === 'true',
    ...(Number.isFinite(reset) ? { resetAt: reset } : {}),
  }
}

const QUOTA_HEADERS = [
  'x-quota-snapshot-premium_models',
  'x-quota-snapshot-premium_interactions',
  'x-quota-snapshot-chat',
  'x-usage-ratelimit-session',
  'x-usage-ratelimit-weekly',
] as const

/** Latest reset among the windows these headers report as exhausted. */
function exhaustedWindowResetMs(headers: Headers, now: number): number | null {
  const resets: number[] = []
  for (const name of QUOTA_HEADERS) {
    const snapshot = parseCopilotQuotaSnapshot(headers.get(name))
    if (
      snapshot &&
      snapshot.percentRemaining <= 0 &&
      !snapshot.overagePermitted &&
      snapshot.resetAt &&
      snapshot.resetAt > now
    )
      resets.push(snapshot.resetAt - now)
  }
  return resets.length ? Math.max(...resets) : null
}

/** `copilot_internal/user` carries the account's quota reset date. */
async function userQuotaResetMs(grant: SubscriptionGrant, now: number, signal?: AbortSignal): Promise<number | null> {
  if (!grant.refreshToken) return null
  try {
    const response = await fetch('https://api.github.com/copilot_internal/user', {
      headers: {
        authorization: `token ${grant.refreshToken}`,
        ...copilotClientHeaders(),
        'x-github-api-version': COPILOT_TOKEN_API_VERSION,
        accept: 'application/json',
      },
      signal: withTimeoutSignal(5_000, signal),
      redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel()
      return null
    }
    const data = z.object({ quota_reset_date_utc: z.string().optional(), quota_reset_date: z.string().optional() })
      .parse(await response.json())
    const reset = Date.parse(data.quota_reset_date_utc ?? data.quota_reset_date ?? '')
    return Number.isFinite(reset) && reset > now ? reset - now : null
  } catch (_quotaUnavailable) {
    // The reset time only refines the retry hint; the next UTC month bounds it.
    return null
  }
}

/** Premium and chat quotas reset on the first of the month, 00:00 UTC. */
function untilNextUtcMonth(now: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - now
}

/**
 * A quota failure carries no Retry-After, so a caller would re-probe an exhausted account
 * on its generic backoff. Attach the real reset time (the exhausted quota window, then
 * `copilot_internal/user`, then the next UTC month); an upstream Retry-After always wins.
 * HTTP 402 becomes 429, the status that means "retry later" to the adapter.
 * @param response - Copilot response.
 * @param grant - account credential used to look up the reset.
 * @param signal - caller cancellation.
 * @param now - current epoch milliseconds.
 * @returns the response with its body intact.
 */
export async function annotateQuotaFailure(
  response: Response,
  grant: SubscriptionGrant,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<Response> {
  if (response.ok) return response
  const text = await response.text()
  const headers = new Headers(response.headers)
  let status = response.status
  if (isCopilotQuotaFailure(status, text)) {
    if (!headers.has('retry-after')) {
      const delay =
        exhaustedWindowResetMs(response.headers, now) ??
        (await userQuotaResetMs(grant, now, signal)) ??
        untilNextUtcMonth(now)
      headers.set('retry-after', String(Math.max(1, Math.ceil(delay / 1000))))
    }
    if (status === 402) status = 429
  }
  return new Response(text, {
    status,
    statusText: status === response.status ? response.statusText : '',
    headers,
  })
}

/**
 * Send one chat request to the account's Copilot origin.
 * @param grant - resolved Copilot subscription credential.
 * @param body - OpenAI chat request.
 * @param request - conversation-start flag, durable session id, and cancellation.
 * @returns the upstream response, with quota exhaustion annotated.
 */
export async function callCopilot(
  grant: SubscriptionGrant,
  body: unknown,
  request: { initiator: 'user' | 'agent'; session?: string | undefined; signal: AbortSignal },
): Promise<Response> {
  const response = await fetch(`${copilotBase(grant)}/chat/completions`, {
    method: 'POST',
    redirect: 'error',
    signal: request.signal,
    headers: copilotHeaders(grant, request.initiator, request.session),
    body: JSON.stringify(body),
  })
  return annotateQuotaFailure(response, grant, request.signal)
}
