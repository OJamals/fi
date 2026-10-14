/** Authenticated model catalogs for native subscription providers. */
import { z } from 'zod'
import { copilotBase, copilotHeaders } from './copilot.ts'
import { cursorModels } from './native/cursor-api.ts'
import { kiroHeaders } from './native/kiro-api.ts'
import { CODE_ASSIST_BASE, geminiHeaders } from './gemini-auth.ts'
import { clineHeaders, json, kiroRegion } from './protocol.ts'
import type { SubscriptionGrant, SubscriptionOptions } from './protocol.ts'

/**
 * Discover advertised model ids using the account captured for this request.
 * @param grant - current provider credential.
 * @param config - request deadline.
 * @param signal - caller cancellation.
 * @returns distinct advertised model ids.
 */
export async function catalog(
  grant: SubscriptionGrant,
  config: SubscriptionOptions,
  signal?: AbortSignal,
): Promise<string[]> {
  if (grant.provider === 'copilot') {
    const data = z.object({ data: z.array(z.object({
      id: z.string().min(1),
      supported_endpoints: z.array(z.string()).optional(),
      capabilities: z.object({ type: z.string().optional() }).optional(),
    })) }).parse(await json(`${copilotBase(grant)}/models`, config, {
      headers: copilotHeaders(grant.accessToken), signal: signal ?? null,
    }))
    return [...new Set(data.data.filter(model =>
      model.capabilities?.type === 'chat' &&
      (model.supported_endpoints === undefined || model.supported_endpoints.includes('/chat/completions')),
    ).map(model => model.id))]
  }
  if (grant.provider === 'cursor') return cursorModels(grant, config.requestTimeoutMs, signal)
  if (grant.provider === 'kiro') {
    const query = new URLSearchParams({ origin: 'AI_EDITOR' })
    if (grant.subscriptionAuth?.profileArn) query.set('profileArn', grant.subscriptionAuth.profileArn)
    const data = z
      .object({ models: z.array(z.object({ modelId: z.string().min(1).regex(/^\S+$/) })) })
      .parse(
        await json(
          `https://q.${kiroRegion(grant.subscriptionAuth)}.amazonaws.com/ListAvailableModels?${query}`,
          config,
          { headers: kiroHeaders(grant), signal: signal ?? null },
        ),
      )
    return [...new Set(data.models.map(model => model.modelId))]
  }
  if (grant.provider === 'cline') {
    const row = z.object({ id: z.string() })
    const data = z
      .object({ free: z.array(row), clinePass: z.array(row) })
      .parse(
        await json('https://api.cline.bot/api/v1/ai/cline/recommended-models', config, {
          headers: clineHeaders(grant.accessToken),
          signal: signal ?? null,
        }),
      )
    return [
      ...new Set(
        [...data.free, ...data.clinePass]
          .map(model => model.id)
          .filter(id => /^cline-(?:pass|free)\/[A-Za-z0-9._:-]+$/.test(id)),
      ),
    ]
  }
  const project = grant.subscriptionAuth?.projectId
  if (!project) throw new Error('Code Assist has no project; sign in again')
  const data = z.object({ buckets: z.array(z.object({ modelId: z.string() })) }).parse(
    await json(`${CODE_ASSIST_BASE}:retrieveUserQuota`, config, {
      method: 'POST',
      headers: geminiHeaders(grant.accessToken),
      body: JSON.stringify({ project }),
      signal: signal ?? null,
    }),
  )
  return [...new Set(data.buckets.map(bucket => bucket.modelId).filter(id => /^gemini-[A-Za-z0-9._-]+$/.test(id)))]
}
