/** Authenticated model catalogs for native subscription providers. */
import { z } from 'zod'
import { copilotBase, copilotHeaders } from './copilot.ts'
import { cursorModels } from './native/cursor-api.ts'
import { kiroHeaders } from './native/kiro-api.ts'
import { CODE_ASSIST_BASE, geminiHeaders } from './gemini-auth.ts'
import { clineHeaders, json, kiroRegion } from './protocol.ts'
import type { SubscriptionGrant, SubscriptionOptions } from './protocol.ts'

/** One advertised model and whether its route forwards image input. */
export interface CatalogModel {
  /** Model id the provider accepts. */
  id: string
  /**
   * Image support the catalog states: `true` for every Cursor and Gemini CLI model, `false` for every Cline model.
   * Copilot states it when `capabilities.supports` is an object (`supports.vision === true`), Kiro when
   * `supportedInputTypes` is an array (it includes `IMAGE`); absent when the row states neither, as auth2api leaves it.
   */
  vision?: boolean
}

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
  return (await catalogModels(grant, config, signal)).map(model => model.id)
}

const imageModels = (ids: readonly string[], vision: boolean): CatalogModel[] => ids.map(id => ({ id, vision }))

/**
 * Discover advertised models and their image support using the account captured for this request.
 * @param grant - current provider credential.
 * @param config - request deadline.
 * @param signal - caller cancellation.
 * @returns distinct advertised models in catalog order.
 */
export async function catalogModels(
  grant: SubscriptionGrant,
  config: SubscriptionOptions,
  signal?: AbortSignal,
): Promise<CatalogModel[]> {
  if (grant.provider === 'copilot') {
    const data = z.object({ data: z.array(z.object({
      id: z.string().min(1),
      supported_endpoints: z.array(z.string()).optional(),
      capabilities: z.object({
        type: z.string().optional(),
        // Read leniently: an odd supports value on one row must not hide the whole catalog.
        supports: z.unknown().optional(),
      }).optional(),
      policy: z.object({ state: z.string().optional() }).optional(),
    })) }).parse(await json(`${copilotBase(grant)}/models`, config, {
      headers: copilotHeaders(grant), signal: signal ?? null,
    }))
    // A disabled policy is refused upstream (model_not_supported). model_picker_enabled is not a
    // filter: it is false for every model on a Free account, and picker-hidden dated aliases still answer.
    const models = new Map<string, CatalogModel>()
    for (const model of data.data) {
      if (model.capabilities?.type === 'chat' &&
        model.policy?.state !== 'disabled' &&
        (model.supported_endpoints === undefined || model.supported_endpoints.includes('/chat/completions')) &&
        !models.has(model.id)) {
        const supports = z.record(z.string(), z.unknown()).safeParse(model.capabilities.supports).data
        models.set(model.id, { id: model.id, ...supports === undefined ? {} : { vision: supports['vision'] === true } })
      }
    }
    return [...models.values()]
  }
  // Cursor's selected_images and Code Assist's inline data accept images for every advertised model.
  if (grant.provider === 'cursor') return imageModels(await cursorModels(grant, config.requestTimeoutMs, signal), true)
  if (grant.provider === 'kiro') {
    const query = new URLSearchParams({ origin: 'AI_EDITOR' })
    if (grant.subscriptionAuth?.profileArn) query.set('profileArn', grant.subscriptionAuth.profileArn)
    const deadline = AbortSignal.any([AbortSignal.timeout(config.requestTimeoutMs), ...signal ? [signal] : []])
    const models = new Map<string, CatalogModel>()
    const cursors = new Set<string>()
    for (;;) {
      deadline.throwIfAborted()
      const data = z.object({
        models: z.array(z.object({ modelId: z.string().min(1).regex(/^\S+$/), supportedInputTypes: z.unknown().optional() })),
        nextToken: z.string().nullish(),
      }).parse(
        await json(
          `https://q.${kiroRegion(grant.subscriptionAuth)}.amazonaws.com/ListAvailableModels?${query}`,
          config,
          { headers: kiroHeaders(grant, 'runtime'), signal: deadline },
        ),
      )
      for (const model of data.models) {
        if (!models.has(model.modelId)) {
          const inputTypes = z.array(z.unknown()).safeParse(model.supportedInputTypes).data
          models.set(model.modelId, { id: model.modelId, ...inputTypes === undefined ? {} : { vision: inputTypes.includes('IMAGE') } })
        }
      }
      if (!data.nextToken) return [...models.values()]
      if (cursors.has(data.nextToken)) throw new Error('Kiro model catalog repeated a pagination token')
      cursors.add(data.nextToken)
      query.set('nextToken', data.nextToken)
    }
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
    // auth2api forwards no Cline media: Cline's model modalities vary and its catalog does not disclose them.
    return imageModels([
      ...new Set(
        [...data.free, ...data.clinePass]
          .map(model => model.id)
          .filter(id => /^cline-(?:pass|free)\/[A-Za-z0-9._:-]+$/.test(id)),
      ),
    ], false)
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
  return imageModels([...new Set(data.buckets.map(bucket => bucket.modelId).filter(id => /^gemini-[A-Za-z0-9._-]+$/.test(id)))], true)
}
