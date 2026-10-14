/** Ollama Cloud device identity and signed HTTP requests. */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { z } from 'zod'

/** Deployment deadlines and the name displayed by Ollama's device approval page. */
export interface OllamaOptions {
  /** Device label shown on Ollama's browser approval page. */
  deviceName: string
  /** Maximum milliseconds for one cloud HTTP request. */
  requestTimeoutMs: number
  /** Maximum milliseconds allowed for browser approval. */
  authTimeoutMs: number
  /** Milliseconds between pending account checks. */
  pollIntervalMs: number
  /** Maximum milliseconds without an inference stream event. */
  streamIdleTimeoutMs: number
  /** Context capacity when model metadata omits it. */
  defaultContextWindow: number
  /** Output token limit when the request does not specify one. */
  defaultMaxTokens: number
}

/** Stored FI-owned device key; it never leaves the Host credential store. */
export const grantSchema = z.object({
  type: z.literal('device'), privateKey: z.string().min(1), account: z.string().min(1),
})

/** Durable device identity approved by an Ollama account. */
export type OllamaGrant = z.infer<typeof grantSchema>

/**
 * Generate an independent Ed25519 device identity for one sign-in attempt.
 * @returns PKCS8 private key accepted by Node's signing implementation.
 */
export function newDeviceKey(): string {
  return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
}

/**
 * Encode the public key using SSH's length-prefixed Ed25519 format.
 * @param privateKey - FI's PKCS8 device key.
 * @returns base64 SSH public-key blob used by Ollama's signer.
 */
export function publicKeyBlob(privateKey: string): string {
  const key = createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ollama device key must be Ed25519')
  const jwk = createPublicKey(key).export({ format: 'jwk' })
  const publicKey = Buffer.from(z.string().parse(jwk.x), 'base64url')
  const field = (value: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(value.length)
    return Buffer.concat([length, value])
  }
  return Buffer.concat([field(Buffer.from('ssh-ed25519')), field(publicKey)]).toString('base64')
}

/**
 * Create the official device-approval URL, containing only the public key.
 * @param privateKey - local device identity.
 * @param name - display name configured for FI.
 * @returns HTTPS browser URL; no callback server or daemon is required.
 */
export function connectUrl(privateKey: string, name: string): string {
  const url = new URL('https://ollama.com/connect')
  url.searchParams.set('name', name)
  url.searchParams.set('key', Buffer.from(`ssh-ed25519 ${publicKeyBlob(privateKey)}`).toString('base64url'))
  return url.href
}

/**
 * Sign one supported Ollama Cloud request and refuse redirects.
 * @param privateKey - approved device key, or a pending key when polling `/api/me`.
 * @param request - unsigned request with caller-owned cancellation.
 * @returns raw cloud response; the operation owns HTTP status handling.
 */
export async function cloudFetch(privateKey: string, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const allowed = new Map([['/api/me', 'POST'], ['/api/tags', 'GET'], ['/api/show', 'POST'], ['/v1/chat/completions', 'POST']])
  if (url.origin !== 'https://ollama.com' || url.username || url.password || url.search || url.hash
    || allowed.get(url.pathname) !== request.method) throw new Error('Ollama transport changed the cloud endpoint')
  request.signal.throwIfAborted()
  url.searchParams.set('ts', String(Math.floor(Date.now() / 1000)))
  const signature = sign(null, Buffer.from(`${request.method},${url.pathname}${url.search}`), privateKey).toString('base64')
  const headers = new Headers(request.headers)
  headers.set('authorization', `${publicKeyBlob(privateKey)}:${signature}`)
  return fetch(new Request(url, request), { headers, redirect: 'error' })
}

/**
 * Read validated-operation JSON under the configured request deadline.
 * @param config - request deadline configuration.
 * @param grant - account device identity.
 * @param path - cloud API path.
 * @param body - optional JSON body; absence sends GET.
 * @param signal - operation cancellation.
 * @returns untrusted cloud JSON, parsed by the caller.
 */
export async function cloudJson(
  config: OllamaOptions, grant: OllamaGrant, path: string, body?: object, signal?: AbortSignal,
): Promise<unknown> {
  const response = await cloudFetch(grant.privateKey, new Request(`https://ollama.com${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    signal: AbortSignal.any([AbortSignal.timeout(config.requestTimeoutMs), ...signal === undefined ? [] : [signal]]),
  }))
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(response.status === 401 ? 'Ollama Cloud authorization expired or was revoked; sign in again' : `Ollama Cloud request failed (${response.status})`)
  }
  return response.json()
}
