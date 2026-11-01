/**
 * Cursor's own OAuth refresh grant, the one its desktop client and CLI use:
 *   POST https://api2.cursor.sh/oauth/token
 *   {"grant_type":"refresh_token","client_id":"<public client>","refresh_token":"<jwt>"}
 *   -> {"access_token","id_token","shouldLogout"}   (shouldLogout=true: sign in again)
 * The response carries no new refresh token, so the stored one stays valid. The alternative
 * `/auth/exchange_user_api_key` exchanges a Cursor user API key and answers 401 to a refresh
 * token, so it is not used.
 */
import { z } from 'zod'
import { withTimeoutSignal } from './protocol.ts'
import type { SubscriptionGrant, SubscriptionOptions } from './protocol.ts'

const TOKEN_URL = 'https://api2.cursor.sh/oauth/token'
// Cursor's public Auth0 client id; the same value is embedded in the IDE.
const CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB'
/** Cursor tokens refresh this long before expiry, the margin both reference clients use. */
export const CURSOR_REFRESH_LEAD_MS = 300_000

const claimsSchema = z.object({ sub: z.string().optional(), exp: z.number().optional() })

function claims(token: string): z.infer<typeof claimsSchema> | undefined {
  try {
    return claimsSchema.parse(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()))
  } catch (_malformedToken) {
    return undefined
  }
}

/**
 * Exchange the stored refresh token for a new access token.
 * @param current - expiring Cursor grant.
 * @param config - operation deadline.
 * @param signal - caller cancellation.
 * @returns the grant with the new access token and expiry.
 */
export async function refreshCursor(
  current: SubscriptionGrant,
  config: SubscriptionOptions,
  signal?: AbortSignal,
): Promise<SubscriptionGrant> {
  if (!current.refreshToken) throw new Error('Cursor authorization expired; sign in again')
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: current.refreshToken }),
    signal: withTimeoutSignal(config.requestTimeoutMs, signal),
    redirect: 'error',
  })
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel()
    throw new Error('Cursor authorization was revoked; sign in again')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Cursor token refresh failed (${response.status})`)
  }
  const data = z.object({ access_token: z.string().optional(), shouldLogout: z.boolean().optional() }).parse(
    await response.json(),
  )
  if (data.shouldLogout === true) throw new Error('Cursor requested a new login; sign in again')
  if (!data.access_token) throw new Error('Cursor token refresh returned no access token')
  const next = claims(data.access_token)
  if (next?.exp === undefined || !Number.isFinite(next.exp) || next.exp * 1000 <= Date.now() || next.exp * 1000 > 8.64e15)
    throw new Error('Cursor token refresh returned an invalid token expiry')
  const previous = claims(current.accessToken)
  if (previous?.sub && next.sub && previous.sub !== next.sub)
    throw new Error('Cursor refreshed token belongs to a different account')
  return { ...current, accessToken: data.access_token, expiresAt: new Date(next.exp * 1000).toISOString() }
}
