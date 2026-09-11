/** Google PKCE OAuth used by the Antigravity CLI-compatible adapter. */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { URL } from 'node:url'
import {
  ANTIGRAVITY_API_BASE_URL,
  ANTIGRAVITY_OAUTH_CLIENT_ID,
  ANTIGRAVITY_OAUTH_CLIENT_SECRET,
  ANTIGRAVITY_OAUTH_SCOPES,
  ANTIGRAVITY_PROJECT_DISCOVERY_URL,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_USER_AGENT,
} from './compat.ts'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USER_INFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

/** PKCE values generated for one authorization attempt. */
export interface PKCECodes {
  readonly codeVerifier: string
  readonly codeChallenge: string
}

/** The JSON grant stored under `fi-antigravity/antigravity`. */
export interface AntigravityTokenData {
  readonly provider: 'antigravity'
  readonly accessToken: string
  readonly refreshToken: string
  readonly email: string
  readonly expiresAt: string
  /** Cloud Code project id; retained under both legacy and explicit names. */
  readonly accountUuid: string
  readonly antigravityProjectId?: string
  readonly idToken?: string
}

/** Result delivered by the loopback OAuth callback. */
export interface AntigravityCallbackResult {
  readonly code: string
  readonly state: string
}

/** Options for the loopback callback listener. */
export interface AntigravityCallbackOptions {
  readonly port?: number
  readonly callbackPath?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal | null
}

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
}

interface OAuthConfig {
  readonly clientId: string
  readonly clientSecret?: string
  readonly redirectUri: string
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/** Generate the verifier and S256 challenge used by Google's installed app. */
export function generateAntigravityPKCE(): PKCECodes {
  const codeVerifier = base64url(randomBytes(96))
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest())
  return { codeVerifier, codeChallenge }
}

function getOAuthConfig(): OAuthConfig {
  return {
    clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || ANTIGRAVITY_OAUTH_CLIENT_ID,
    clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || ANTIGRAVITY_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.ANTIGRAVITY_OAUTH_REDIRECT_URI || ANTIGRAVITY_REDIRECT_URI,
  }
}

function expiresAt(expiresIn: number | undefined): string {
  return new Date(Date.now() + (expiresIn ?? 3_600) * 1_000).toISOString()
}

function abortError(reason: unknown = 'authorization cancelled'): Error {
  if (reason instanceof Error) return reason
  return new DOMException(String(reason), 'AbortError')
}

async function tokenRequest(params: URLSearchParams, signal?: AbortSignal | null): Promise<GoogleTokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': ANTIGRAVITY_USER_AGENT,
    },
    body: params,
    signal: signal ?? null,
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Antigravity OAuth token request failed (${response.status}): ${detail}`)
  }
  return await response.json() as GoogleTokenResponse
}

async function getUserEmail(accessToken: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(USER_INFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': ANTIGRAVITY_USER_AGENT,
    },
    signal: signal ?? null,
  })
  if (!response.ok) throw new Error(`Antigravity user info request failed (${response.status})`)
  const data = await response.json() as { email?: unknown }
  if (typeof data.email !== 'string' || data.email.length === 0) {
    throw new Error('Google user info response omitted email')
  }
  return data.email
}

/** Discover the Cloud Code project attached to an OAuth grant. */
export async function discoverAntigravityProject(
  accessToken: string,
  signal?: AbortSignal | null,
): Promise<string> {
  const configured = process.env.ANTIGRAVITY_PROJECT_ID
  if (configured) return configured

  const response = await fetch(ANTIGRAVITY_PROJECT_DISCOVERY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': ANTIGRAVITY_USER_AGENT,
    },
    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    signal: signal ?? null,
  })
  const status = response.status
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Antigravity project discovery failed (${status}): ${detail}`)
  }
  const data = await response.json() as {
    cloudaicompanionProject?: string | { id?: string }
    project?: string | { id?: string; projectId?: string }
  }
  const companion = data.cloudaicompanionProject
  const project = data.project
  const projectId =
    (typeof companion === 'string' ? companion : companion?.id)
    || (typeof project === 'string' ? project : project?.id || project?.projectId)
  if (projectId) return projectId
  throw new Error(
    'Antigravity project discovery response omitted cloudaicompanionProject; '
    + 'authorize an Antigravity Cloud Code project and retry login.',
  )
}

/** Resolve the callback listener address from the configured redirect URI. */
export function getAntigravityOAuthCallback(): { callbackPort: number; callbackPath: string } {
  const redirect = new URL(process.env.ANTIGRAVITY_OAUTH_REDIRECT_URI || ANTIGRAVITY_REDIRECT_URI)
  const callbackPort = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80))
  return { callbackPort, callbackPath: redirect.pathname || '/callback' }
}

/** Start the one-shot loopback callback listener used by the browser flow. */
export function waitForAntigravityCallback(
  options: AntigravityCallbackOptions = {},
): Promise<AntigravityCallbackResult> {
  const configured = getAntigravityOAuthCallback()
  const port = options.port ?? configured.callbackPort
  const callbackPath = options.callbackPath ?? configured.callbackPath
  const timeoutMs = options.timeoutMs ?? 300_000

  return new Promise((resolve, reject) => {
    let settled = false
    const server = createServer((request, response) => {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== callbackPath) {
        response.writeHead(404)
        response.end()
        return
      }
      const error = url.searchParams.get('error')
      if (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(`OAuth error: ${error}`)
        finish(new Error(`OAuth error: ${error}`))
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!code || !state) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Missing code or state parameter')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>Login successful</title><p>You can close this tab.</p>')
      finish(undefined, { code, state })
    })
    const timer = setTimeout(() => finish(new Error('Antigravity OAuth callback timeout')), timeoutMs)
    const onAbort = (): void => finish(abortError(options.signal?.reason))

    const finish = (error?: Error, result?: AntigravityCallbackResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      server.close()
      if (error !== undefined) reject(error)
      else if (result !== undefined) resolve(result)
      else reject(new Error('Antigravity OAuth callback ended without a result'))
    }

    server.once('error', error => finish(error))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    server.listen(port, '127.0.0.1')
  })
}

/** Build Google's OAuth authorization URL for one state and PKCE pair. */
export function generateAntigravityAuthURL(state: string, pkce: PKCECodes): string {
  const config = getOAuthConfig()
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: ANTIGRAVITY_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${AUTH_URL}?${params.toString()}`
}

/** Exchange a callback code, then resolve the user's email and Cloud Code project. */
export async function exchangeAntigravityCode(
  code: string,
  returnedState: string,
  expectedState: string,
  pkce: PKCECodes,
  signal?: AbortSignal | null,
): Promise<AntigravityTokenData> {
  if (returnedState !== expectedState) throw new Error('OAuth state mismatch — possible CSRF attack')
  const config = getOAuthConfig()
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code,
    code_verifier: pkce.codeVerifier,
  })
  if (config.clientSecret) params.set('client_secret', config.clientSecret)

  const token = await tokenRequest(params, signal)
  if (!token.access_token || !token.refresh_token) {
    throw new Error(
      'Google token response omitted access_token or refresh_token; revoke consent and retry login.',
    )
  }
  const [email, projectId] = await Promise.all([
    getUserEmail(token.access_token, signal ?? undefined),
    discoverAntigravityProject(token.access_token, signal ?? undefined),
  ])
  return {
    provider: 'antigravity',
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    email,
    expiresAt: expiresAt(token.expires_in),
    accountUuid: projectId,
    antigravityProjectId: projectId,
    ...token.id_token === undefined ? {} : { idToken: token.id_token },
  }
}

/** Refresh an Antigravity access token while retaining its refresh token. */
export async function refreshAntigravityTokens(
  refreshToken: string,
  signal?: AbortSignal | null,
): Promise<AntigravityTokenData> {
  const config = getOAuthConfig()
  const params = new URLSearchParams({
    client_id: config.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  if (config.clientSecret) params.set('client_secret', config.clientSecret)
  const token = await tokenRequest(params, signal)
  if (!token.access_token) throw new Error('Google refresh response omitted access_token')
  return {
    provider: 'antigravity',
    accessToken: token.access_token,
    refreshToken: token.refresh_token || refreshToken,
    email: '',
    expiresAt: expiresAt(token.expires_in),
    accountUuid: '',
    ...token.id_token === undefined ? {} : { idToken: token.id_token },
  }
}

/** Exported for diagnostics and tests without exposing the private config object. */
export const ANTIGRAVITY_OAUTH_ENDPOINTS = {
  authorize: AUTH_URL,
  token: TOKEN_URL,
  userInfo: USER_INFO_URL,
  apiBase: ANTIGRAVITY_API_BASE_URL,
} as const
