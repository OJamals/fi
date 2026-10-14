/** Browser-approved Ollama device keys in the canonical credential store. */
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import { cloudFetch, connectUrl, grantSchema, newDeviceKey, publicKeyBlob } from './protocol.ts'
import type { OllamaGrant, OllamaOptions } from './protocol.ts'

/** Credential identity shared by sign-in, discovery, and inference. */
export const OLLAMA_KEY = credentialKey('fi-ollama', 'ollama-cloud')

/**
 * Register native browser device approval without an OAuth callback or daemon.
 * @param ctx - authorization and credential services.
 * @param options - current validated settings, frozen for each attempt.
 */
export function registerOllamaFlow(ctx: Context, options: () => OllamaOptions): void {
  ctx.authorization.registerFlow({
    key: OLLAMA_KEY, label: 'Ollama Cloud', methods: [{ id: 'device', label: 'Sign in with Ollama Cloud' }],
    async run(session) {
      const config = options()
      const privateKey = newDeviceKey()
      const signal = AbortSignal.any([session.signal, AbortSignal.timeout(config.authTimeoutMs)])
      session.notify({ message: 'Open this page and approve FI in your Ollama account.', url: connectUrl(privateKey, config.deviceName) })
      while (true) {
        await delay(config.pollIntervalMs, undefined, { signal })
        const response = await cloudFetch(privateKey, new Request('https://ollama.com/api/me', {
          method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]),
        }))
        if (response.status === 401) { await response.body?.cancel(); continue }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Ollama sign-in failed (${response.status})`) }
        const user = z.object({ name: z.string().min(1) }).parse(await response.json())
        signal.throwIfAborted()
        await ctx.credentials.modifyRecord(OLLAMA_KEY, () => {
          signal.throwIfAborted()
          return Promise.resolve({ kind: 'grant', payload: { type: 'device', privateKey, account: user.name } })
        })
        return
      }
    },
  })
}

/**
 * Resolve the stored device identity without importing other applications' keys.
 * @param ctx - canonical credential service.
 * @param signal - caller cancellation.
 * @returns validated grant, or undefined after local sign-out.
 */
export async function resolveOllamaGrant(ctx: Context, signal?: AbortSignal): Promise<OllamaGrant | undefined> {
  signal?.throwIfAborted()
  const record = await ctx.credentials.readRecord(OLLAMA_KEY)
  signal?.throwIfAborted()
  if (record === undefined) return undefined
  if (record.kind !== 'grant') throw new Error('Ollama credential record must be a device grant')
  const grant = grantSchema.parse(record.payload)
  publicKeyBlob(grant.privateKey)
  return grant
}
