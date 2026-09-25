/** Subscription-client request headers derived from canonical provider metadata. */

import type { AuthResult } from '@earendil-works/pi-ai'
import { providerSettingsFor } from './settings.ts'

/** pi-ai provider ids whose subscription transports have captured metadata. */
export type SubscriptionProvider = 'anthropic' | 'openai-codex' | 'xai'

/** Header carrying Harness app identity when a subscription endpoint requires its own User-Agent. */
export const HARNESS_ATTRIBUTION_HEADER = 'X-DeepSeek-Harness-User-Agent'

const MAX_JWT_PAYLOAD_BYTES = 64 * 1024

const CLAUDE_CODE_BETA_ALIASES: Readonly<Record<string, string>> = {
  // Claude Code 2.1.270 sends this private wire name for Anthropic's public
  // `mid-conversation-output-config-2026-07-01` beta.
  'mid-conversation-output-config-2026-07-01': 'per-turn-control-2026-07-01',
}

/**
 * Normalize pi-ai authorization into mutable request headers.
 * @param auth - resolved pi-ai authorization payload.
 * @returns string-valued headers with an API key represented as Bearer authorization when absent.
 */
export function authorizationHeaders(auth: AuthResult['auth']): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  if (auth.apiKey !== undefined && !Object.keys(headers).some(name => name.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${auth.apiKey}`
  }
  return headers
}

function entryOf(headers: Readonly<Record<string, string>>, name: string): [string, string] | undefined {
  const expected = name.toLowerCase()
  return Object.entries(headers).find(([candidate]) => candidate.toLowerCase() === expected)
}

function replace(headers: Readonly<Record<string, string>>, name: string, value: string): Record<string, string> {
  const expected = name.toLowerCase()
  return {
    ...Object.fromEntries(Object.entries(headers).filter(([candidate]) => candidate.toLowerCase() !== expected)),
    [name]: value,
  }
}

function bearerToken(headers: Readonly<Record<string, string>>): string {
  const authorization = entryOf(headers, 'authorization')?.[1]
  if (authorization === undefined || !authorization.startsWith('Bearer ') || authorization.length === 7) {
    throw new Error('subscription request lacks bearer OAuth authorization')
  }
  return authorization.slice(7)
}

function jwtPayload(token: string): Record<string, unknown> {
  const pieces = token.split('.')
  const payloadPart = pieces.at(1)
  if (pieces.length !== 3 || payloadPart === undefined || payloadPart.length > MAX_JWT_PAYLOAD_BYTES * 2) {
    throw new Error('subscription OAuth token does not contain a bounded JWT payload')
  }
  try {
    const bytes = Buffer.from(payloadPart, 'base64url')
    if (bytes.byteLength > MAX_JWT_PAYLOAD_BYTES) throw new Error('oversized')
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw new Error('subscription OAuth token has an invalid JWT payload')
  }
}

function platform(): 'linux' | 'macos' | 'windows' {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

function stainlessOs(): 'FreeBSD' | 'Linux' | 'MacOS' | 'Windows' {
  if (process.platform === 'darwin') return 'MacOS'
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'freebsd') return 'FreeBSD'
  return 'Linux'
}

function stainlessArch(): 'arm64' | 'x64' | 'x86' {
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'x64') return 'x64'
  return 'x86'
}

function preserveHarnessAttribution(headers: Readonly<Record<string, string>>): Record<string, string> {
  if (entryOf(headers, HARNESS_ATTRIBUTION_HEADER) !== undefined) return { ...headers }
  const userAgent = entryOf(headers, 'user-agent')?.[1]
  return userAgent === undefined ? { ...headers } : replace(headers, HARNESS_ATTRIBUTION_HEADER, userAgent)
}

function claudeCodeBetas(
  captured: readonly string[],
  headers: Readonly<Record<string, string>>,
): readonly string[] {
  const requested = entryOf(headers, 'anthropic-beta')?.[1]
    .split(',')
    .map(beta => beta.trim())
    .filter(beta => beta.length > 0)
    ?? []
  return [...new Set([
    ...captured,
    ...requested.map(beta => CLAUDE_CODE_BETA_ALIASES[beta] ?? beta),
  ])]
}

/**
 * Preserve Harness identity before a provider-specific User-Agent replaces it.
 * @param headers - assembled request headers before provider SDK dispatch.
 * @returns a new header record.
 */
export function preserveHarnessHeaders(
  headers: Readonly<Record<string, string | null>>,
): Record<string, string | null> {
  const next = { ...headers }
  const strings = Object.fromEntries(Object.entries(next).filter((entry): entry is [string, string] => entry[1] !== null))
  return { ...next, ...preserveHarnessAttribution(strings) }
}

/**
 * Build capture-derived subscription request headers.
 *
 * Compatibility-owned names replace stale copies case-insensitively; unrelated
 * caller headers and bearer authorization survive. The function validates the
 * final OAuth authorization without logging or retaining it. Grok derives its
 * user id transiently from the access-token subject.
 * @param provider - pi-ai subscription provider id.
 * @param model - exact request model id.
 * @param sessionId - request session id sent only as provider transport metadata.
 * @param timeoutMs - request timeout used for provider timeout metadata.
 * @param existingHeaders - final request headers, including bearer authorization.
 * @returns a new merged header record.
 */
export function subscriptionHeaders(
  provider: SubscriptionProvider,
  model: string,
  sessionId: string,
  timeoutMs: number,
  existingHeaders: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  if (sessionId.length === 0) throw new Error('subscription request sessionId must be non-empty')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('subscription request timeoutMs must be a positive finite number')
  }
  const token = bearerToken(existingHeaders)
  let headers = preserveHarnessAttribution(existingHeaders)

  if (provider === 'openai-codex') {
    const settings = providerSettingsFor('codexCli')
    const payload = jwtPayload(token)
    const account = payload['https://api.openai.com/auth']
    const accountId = account === null || typeof account !== 'object'
      ? undefined
      : (account as Record<string, unknown>).chatgpt_account_id
    if (account === null || typeof account !== 'object'
      || typeof accountId !== 'string') {
      throw new Error('Codex subscription OAuth token lacks a ChatGPT account id')
    }
    headers = replace(headers, 'User-Agent', `${settings.originator}/${settings.version} (${platform()}; ${process.arch === 'arm64' ? 'arm64' : 'x86_64'})`)
    headers = replace(headers, 'originator', settings.originator)
    headers = replace(headers, 'version', settings.version)
    headers = replace(headers, 'ChatGPT-Account-ID', accountId)
    return headers
  }

  if (provider === 'anthropic') {
    if (!token.includes('sk-ant-oat')) throw new Error('Anthropic subscription request lacks a Claude OAuth token')
    const settings = providerSettingsFor('claudeCode')
    const capturedBetas = model.toLowerCase().includes('haiku')
      ? settings.haikuMessageBetas
      : settings.messageBetas
    const betas = claudeCodeBetas(capturedBetas, existingHeaders)
    headers = replace(headers, 'User-Agent', `claude-cli/${settings.version} (external, ${settings.entrypoint})`)
    headers = replace(headers, 'X-Claude-Code-Session-Id', sessionId)
    headers = replace(headers, 'X-Stainless-Lang', 'js')
    headers = replace(headers, 'X-Stainless-Package-Version', settings.stainless.packageVersion)
    headers = replace(headers, 'X-Stainless-Runtime', settings.stainless.runtime)
    headers = replace(headers, 'X-Stainless-Runtime-Version', settings.stainless.runtimeVersion)
    headers = replace(headers, 'X-Stainless-Arch', stainlessArch())
    headers = replace(headers, 'X-Stainless-Os', stainlessOs())
    headers = replace(headers, 'X-Stainless-Retry-Count', '0')
    headers = replace(headers, 'X-Stainless-Timeout', String(Math.max(1, Math.ceil(timeoutMs / 1000))))
    headers = replace(headers, 'anthropic-dangerous-direct-browser-access', 'true')
    headers = replace(headers, 'anthropic-version', '2023-06-01')
    headers = replace(headers, 'anthropic-beta', betas.join(','))
    headers = replace(headers, 'x-app', 'cli')
    return headers
  }

  const settings = providerSettingsFor('grokCode')
  const subject = jwtPayload(token).sub
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new Error('Grok subscription OAuth token lacks a subject')
  }
  headers = replace(headers, 'User-Agent', `${settings.clientIdentifier}/${settings.version} (${platform()}; ${process.arch === 'arm64' ? 'aarch64' : 'x86_64'})`)
  headers = replace(headers, 'X-XAI-Token-Auth', settings.tokenAuth)
  headers = replace(headers, 'x-grok-client-version', settings.version)
  headers = replace(headers, 'x-grok-client-mode', settings.clientMode)
  headers = replace(headers, 'x-grok-client-identifier', settings.clientIdentifier)
  headers = replace(headers, 'x-grok-model-override', model)
  headers = replace(headers, 'x-grok-user-id', subject)
  return headers
}
