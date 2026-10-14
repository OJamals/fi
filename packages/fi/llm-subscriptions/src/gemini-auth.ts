/** Google Code Assist OAuth and project entitlement resolution. */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { z } from 'zod'
import { json } from './protocol.ts'
import type { SubscriptionGrant, SubscriptionOptions } from './protocol.ts'

/** Fixed Code Assist API origin. */
export const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com/v1internal'
const metadata = { ideType: 'IDE_UNSPECIFIED', pluginType: 'GEMINI', platform: 'PLATFORM_UNSPECIFIED' }
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().max(31_536_000),
})

/**
 * Identify a native Code Assist request.
 * @param token - authorized Google access token.
 * @returns headers for the fixed Google origin.
 */
export function geminiHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'fi-code-assist/0.2.0' }
}

async function tokenRequest(fields: Record<string, string>, config: SubscriptionOptions, signal?: AbortSignal) {
  requireClient(config)
  return tokenSchema.parse(
    await json('https://oauth2.googleapis.com/token', config, {
      method: 'POST',
      signal: signal ?? null,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.geminiClientId,
        client_secret: config.geminiClientSecret,
        ...fields,
      }),
    }),
  )
}

function requireClient(config: SubscriptionOptions): void {
  if (!config.geminiClientId.trim() || !config.geminiClientSecret.trim())
    throw new Error('Configure geminiClientId and geminiClientSecret before Google Code Assist authorization')
}

/**
 * Resolve or onboard the account's eligible Code Assist project.
 * @param token - authorized Google access token.
 * @param config - project override and operation deadlines.
 * @param signal - authorization cancellation.
 * @returns eligible project id.
 */
export async function discoverProject(
  token: string,
  config: SubscriptionOptions,
  signal: AbortSignal,
): Promise<string> {
  const project = config.geminiProjectId || undefined
  const rpc = (method: string, body: unknown) =>
    json(`${CODE_ASSIST_BASE}:${method}`, config, {
      method: 'POST',
      headers: geminiHeaders(token),
      body: JSON.stringify(body),
      signal,
    })
  const loaded = z
    .object({
      currentTier: z.object({ id: z.string() }).optional(),
      cloudaicompanionProject: z.string().optional(),
      ineligibleTiers: z.array(z.object({ reasonCode: z.string() })).optional(),
      allowedTiers: z
        .array(
          z.object({
            id: z.string(),
            isDefault: z.boolean().optional(),
            userDefinedCloudaicompanionProject: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .parse(
      await rpc('loadCodeAssist', {
        cloudaicompanionProject: project,
        metadata: { ...metadata, duetProject: project },
      }),
    )
  if (loaded.currentTier) {
    const resolved = loaded.cloudaicompanionProject || project
    if (resolved) return resolved
    throw new Error('Code Assist requires geminiProjectId; Google returned no project')
  }
  if (!project && loaded.ineligibleTiers?.some(tier => tier.reasonCode === 'UNSUPPORTED_CLIENT')) {
    throw new Error(
      'Google reports UNSUPPORTED_CLIENT for Code Assist; use an eligible Cloud project or sign in with Antigravity',
    )
  }
  const tier = loaded.allowedTiers?.find(value => value.isDefault)
  if (!tier) throw new Error('No eligible Code Assist onboarding tier')
  if (tier.userDefinedCloudaicompanionProject && !project)
    throw new Error('This Code Assist account requires geminiProjectId')
  const operationSchema = z.object({
    done: z.boolean().optional(),
    name: z.string().optional(),
    error: z.unknown().optional(),
    response: z
      .object({ cloudaicompanionProject: z.union([z.string(), z.object({ id: z.string() })]).optional() })
      .optional(),
  })
  let operation = operationSchema.parse(
    await rpc('onboardUser', {
      tierId: tier.id,
      cloudaicompanionProject: tier.id === 'free-tier' ? undefined : project,
      metadata: { ...metadata, duetProject: tier.id === 'free-tier' ? undefined : project },
    }),
  )
  while (!operation.done) {
    if (!operation.name || !/^operations\/[A-Za-z0-9_/-]+$/.test(operation.name))
      throw new Error('Invalid Code Assist onboarding operation')
    await delay(config.pollIntervalMs, undefined, { signal })
    operation = operationSchema.parse(
      await json(`${CODE_ASSIST_BASE}/${operation.name}`, config, { headers: geminiHeaders(token), signal }),
    )
  }
  if (operation.error) throw new Error('Code Assist onboarding failed')
  const value = operation.response?.cloudaicompanionProject
  const resolved = (typeof value === 'string' ? value : value?.id) || project
  if (!resolved) throw new Error('Code Assist onboarding returned no project')
  return resolved
}

/**
 * Complete browser OAuth through a state-checked loopback callback.
 * @param session - human authorization conversation.
 * @param config - OAuth identity, callback port, and deadlines.
 * @param signal - shared authorization deadline and cancellation.
 * @returns account grant with an eligible project.
 */
export async function loginGemini(
  session: AuthorizationSession,
  config: SubscriptionOptions,
  signal: AbortSignal,
): Promise<SubscriptionGrant> {
  requireClient(config)
  const state = randomBytes(32).toString('base64url'),
    verifier = randomBytes(32).toString('base64url')
  const redirect = `http://127.0.0.1:${config.geminiCallbackPort}/oauth2callback`
  const result = Promise.withResolvers<string>()
  // Observe rejection while bind/notice is pending; the operation still awaits the same result.
  void result.promise.catch(() => undefined)
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', redirect)
    if (request.method !== 'GET' || url.pathname !== '/oauth2callback' || url.searchParams.get('state') !== state) {
      response.writeHead(400).end('Invalid OAuth callback')
      return
    }
    const code = url.searchParams.get('code')
    response
      .writeHead(code ? 200 : 400, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      .end(code ? 'Sign-in received. Return to Fi.' : 'Authorization denied.')
    if (code) result.resolve(code)
    else result.reject(new Error('Google authorization denied'))
  })
  const abort = () => {
    result.reject(signal.reason)
    server.closeAllConnections()
    server.close()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.geminiCallbackPort, '127.0.0.1', resolve)
    })
    signal.throwIfAborted()
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({
      client_id: config.geminiClientId,
      redirect_uri: redirect,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: ['cloud-platform', 'userinfo.email', 'userinfo.profile']
        .map(value => `https://www.googleapis.com/auth/${value}`)
        .join(' '),
    }).toString()
    session.notify({ message: 'Sign in with Google for Code Assist.', url: url.href })
    const code = await result.promise
    const token = await tokenRequest(
      { code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' },
      config,
      signal,
    )
    if (!token.refresh_token) throw new Error('Google omitted refresh token; retry consent')
    const projectId = await discoverProject(token.access_token, config, signal)
    return {
      provider: 'gemini-cli',
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      subscriptionAuth: { projectId },
    }
  } finally {
    signal.removeEventListener('abort', abort)
    server.closeAllConnections()
    await new Promise<void>(resolve =>
      server.close(() => {
        resolve()
      }),
    )
  }
}

/**
 * Refresh Google access without losing a previously issued refresh token.
 * @param grant - current canonical credential.
 * @param config - OAuth identity and deadline.
 * @param signal - operation cancellation.
 * @returns refreshed grant.
 */
export async function refreshGemini(
  grant: SubscriptionGrant,
  config: SubscriptionOptions,
  signal?: AbortSignal,
): Promise<SubscriptionGrant> {
  const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: grant.refreshToken }, config, signal)
  return {
    ...grant,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? grant.refreshToken,
    expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
  }
}
