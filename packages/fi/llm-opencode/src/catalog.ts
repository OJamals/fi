/** Authenticated OpenCode v2 catalog projection; remote configuration cannot supply credentials. */
import type { Model } from '@earendil-works/pi-ai'
import { setTimeout } from 'node:timers/promises'
import { z } from 'zod'
import { providerSettingsFor } from '@fi/provider-compat'
import { awaitWithAbort, consoleJson, consoleUrl } from './protocol.ts'
import type { ConsoleGrant, ConsoleOptions } from './protocol.ts'
import { overlayReasoning, registryReasoning } from './reasoning.ts'
import type { ConsoleReasoning } from './reasoning.ts'
import { ModelRegistry } from './registry.ts'

const record = z.record(z.string(), z.unknown())
const transientFailure = z.object({ cause: z.object({ code: z.enum([
  'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]) }) })
const modelSchema = z.object({
  modelID: z.string().min(1).optional(), name: z.string().optional(), package: z.string().optional(),
  settings: z.object({ baseURL: z.string().optional() }).optional(),
  headers: z.record(z.string(), z.string()).optional(), body: record.optional(),
  disabled: z.boolean().optional(), status: z.string().optional(),
  capabilities: z.object({
    input: z.array(z.string()).optional(), output: z.array(z.string()).optional(), reasoning: z.unknown().optional(),
  }).optional(),
  limit: z.object({
    context: z.number().int().positive().optional(), output: z.number().int().positive().optional(),
  }).optional(),
})
const providerSchema = modelSchema.omit({ modelID: true, limit: true, capabilities: true }).extend({
  /** Registry provider that supplies missing metadata under a different Console provider id. */
  canonical: z.string().optional(),
  models: z.record(z.string(), modelSchema),
})
const catalogSchema = z.object({
  providers: z.record(z.string(), providerSchema),
  experimental: z.object({ policies: z.array(z.unknown()).optional() }).optional(),
})
type Catalog = z.infer<typeof catalogSchema>
type ProviderEntry = Catalog['providers'][string]
type ModelEntry = ProviderEntry['models'][string]
/** pi-ai API that builds and parses a route's requests. */
export type ConsoleApi = 'anthropic-messages' | 'openai-responses' | 'openai-completions'
/** Wire format a Console package speaks; Google routes use the OpenAI Chat API toward pi-ai and Gemini toward the Console. */
export type ConsoleProtocol = ConsoleApi | 'google-generative-ai'
const protocols: ReadonlyMap<string, ConsoleProtocol> = new Map([
  ['@ai-sdk/anthropic', 'anthropic-messages'],
  ['@ai-sdk/openai', 'openai-responses'],
  ['@ai-sdk/openai-compatible', 'openai-completions'],
  ['@ai-sdk/google', 'google-generative-ai'],
])
const forbiddenHeaders = new RegExp(
  '^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|cookie|set-cookie|host|content-length|connection|transfer-encoding'
  + '|user-agent|x-org-id|x-opencode-.+|x-session-.+)$', 'i',
)
const samplingFields = new Set(['temperature', 'top_p', 'top_k', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'frequency_penalty', 'presence_penalty'])
/** Account and organization catalogs kept at once; a signed-in user rarely has more. */
const MAX_CACHED_CATALOGS = 8

/** Frozen advertised model routing, keeping selection identity separate from wire identity. */
export interface ConsoleModel {
  model: Model<ConsoleApi>
  /** Wire format toward the Console, which differs from `model.api` for Google routes. */
  protocol: ConsoleProtocol
  wireId: string
  headers: Record<string, string>
  body: Record<string, unknown>
  /** Registry or overlay reasoning controls; absent when the catalog says nothing about reasoning. */
  reasoning?: ConsoleReasoning
}

/** Validate an untrusted Console v2 document and refuse organization policies this client cannot evaluate. */
function parseCatalog(data: unknown): Catalog {
  const catalog = catalogSchema.parse(data)
  if ((catalog.experimental?.policies?.length ?? 0) > 0) throw new Error('OpenCode organization policies require the official OpenCode client')
  return catalog
}

/** A registry route is admitted only when it points at an OpenCode endpoint. */
function openCodeEndpoint(endpoint: string): boolean {
  try { consoleUrl(endpoint) } catch (_foreignEndpoint) { return false }
  return true
}

/** Whether the Console left routes for the registry to supply. */
function needsRegistry(provider: ProviderEntry): boolean {
  if (provider.disabled === true) return false
  if (provider.package !== undefined && provider.settings?.baseURL !== undefined) return false
  const models = Object.values(provider.models)
  return models.length === 0 || models.some(model => (model.package ?? provider.package) === undefined
    || (model.settings?.baseURL ?? provider.settings?.baseURL) === undefined)
}

/**
 * Complete a workspace overlay with public registry metadata. Console config is not necessarily a full model
 * inventory: it lists a workspace's exclusions and overrides, and the registry supplies routes, limits,
 * modalities, and reasoning controls for everything else. Only providers the authenticated Console lists are
 * admitted; Console fields always win; registry routes outside OpenCode endpoints are dropped.
 * Follows OpenCode's models-dev.ts and config/plugin/provider.ts at the pinned source revision.
 */
async function completeCatalog(catalog: Catalog, registry: ModelRegistry, config: ConsoleOptions, signal: AbortSignal): Promise<Catalog> {
  if (!Object.values(catalog.providers).some(needsRegistry)) return catalog
  const known = await registry.load(config, signal)
  const providers: Catalog['providers'] = {}
  for (const [id, provider] of Object.entries(catalog.providers)) {
    if (!needsRegistry(provider)) {
      providers[id] = provider
      continue
    }
    const base = known.get(provider.canonical ?? id)
    if (base === undefined) {
      // One provider the registry does not know must not discard every other provider's routes.
      registry.missing(id)
      continue
    }
    const models: Record<string, ModelEntry> = {}
    for (const modelId of new Set([...base.models.keys(), ...Object.keys(provider.models)])) {
      const override = provider.models[modelId] ?? {}
      const source = base.models.get(override.modelID ?? modelId)
      const consoleEndpoint = override.settings?.baseURL ?? provider.settings?.baseURL
      const registryEndpoint = source?.provider?.api ?? base.api
      if (consoleEndpoint === undefined && (registryEndpoint === undefined || !openCodeEndpoint(registryEndpoint))) continue
      const reasoning = override.capabilities?.reasoning ?? (source === undefined ? undefined : registryReasoning(source))
      models[modelId] = {
        ...override,
        modelID: override.modelID ?? source?.id ?? modelId,
        package: override.package ?? provider.package ?? source?.provider?.npm ?? base.npm,
        settings: { baseURL: consoleEndpoint ?? registryEndpoint },
        status: override.status ?? source?.status,
        limit: override.limit ?? source?.limit,
        capabilities: {
          input: override.capabilities?.input ?? source?.modalities?.input,
          output: override.capabilities?.output ?? source?.modalities?.output,
          reasoning,
        },
      }
    }
    providers[id] = { ...provider, models }
  }
  return { ...catalog, providers }
}

/** Keep enabled supported text models of a validated, completed catalog. */
function project(catalog: Catalog, provider: string, config: ConsoleOptions): ConsoleModel[] {
  const result: ConsoleModel[] = []
  for (const [providerId, source] of Object.entries(catalog.providers)) {
    if (source.disabled || source.status === 'deprecated') continue
    for (const [id, entry] of Object.entries(source.models)) {
      if (entry.disabled || entry.status === 'deprecated'
        || (entry.capabilities?.input !== undefined && !entry.capabilities.input.includes('text'))
        || (entry.capabilities?.output !== undefined && !entry.capabilities.output.includes('text'))) continue
      const protocol = protocols.get((entry.package ?? source.package ?? '').replace(/^aisdk:/, ''))
      if (protocol === undefined) continue
      const endpoint = entry.settings?.baseURL ?? source.settings?.baseURL
      if (endpoint === undefined) throw new Error('OpenCode advertised model has no endpoint')
      const baseUrl = consoleUrl(endpoint)
      const headers = Object.fromEntries(Object.entries({ ...source.headers, ...entry.headers })
        .filter(([key, value]) => !forbiddenHeaders.test(key) && !/[\r\n]/.test(key + value)))
      const body = Object.fromEntries(Object.entries({ ...source.body, ...entry.body })
        .filter(([key, value]) => samplingFields.has(key) && typeof value === 'number' && Number.isFinite(value)))
      const selectedId = providerId === 'opencode' ? id : `${providerId}/${id}`
      if (result.some(candidate => candidate.model.id === selectedId)) throw new Error('OpenCode catalog has ambiguous model identifiers')
      const reasoning = overlayReasoning(entry.capabilities?.reasoning)
      const api = protocol === 'google-generative-ai' ? 'openai-completions' : protocol
      result.push({
        protocol, wireId: entry.modelID ?? id, headers, body,
        ...reasoning === undefined ? {} : { reasoning },
        model: {
          provider, id: selectedId, name: entry.name ?? id, api, baseUrl,
          reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: entry.limit?.context ?? config.defaultContextWindow,
          maxTokens: entry.limit?.output ?? config.defaultMaxTokens,
        },
      })
    }
  }
  return result
}

/**
 * Validate a remote catalog and retain supported enabled text models.
 * @param data - untrusted, already completed Console v2 JSON.
 * @param provider - FI route identity used in durable replay.
 * @param config - fallback capacity values from validated deployment configuration.
 * @returns detached models, with namespaced ids when the catalog names another provider.
 */
export function projectCatalog(data: unknown, provider: string, config: ConsoleOptions): ConsoleModel[] {
  return project(parseCatalog(data), provider, config)
}

/** Read the authenticated catalog, retrying transient network failures within one deadline. */
async function fetchCatalog(config: ConsoleOptions, grant: ConsoleGrant, registry: ModelRegistry, deadline: AbortSignal): Promise<Catalog> {
  for (let attempt = 0; ; attempt++) {
    deadline.throwIfAborted()
    try {
      const catalog = parseCatalog(await consoleJson(config, providerSettingsFor('opencodeConsole').catalogPath, {
        headers: { authorization: `Bearer ${grant.access}`, ...grant.orgId === undefined ? {} : { 'x-org-id': grant.orgId } },
        signal: deadline,
      }))
      return await completeCatalog(catalog, registry, config, deadline)
    } catch (error) {
      deadline.throwIfAborted()
      const failure = transientFailure.safeParse(error)
      if (!failure.success) throw error
      if (attempt >= config.catalogRetryCount) {
        throw new Error(`OpenCode catalog network request failed (${failure.data.cause.code}) at ${new URL(config.server).host} after ${attempt + 1} attempts; check connectivity and retry`)
      }
      await setTimeout(Math.min(config.catalogRetryDelayMs * 2 ** attempt, config.requestTimeoutMs), undefined, { signal: deadline })
    }
  }
}

/**
 * Discover models using the current authenticated account and organization, retrying transient network failures within one deadline.
 * @param config - settings frozen for one operation.
 * @param grant - already refreshed canonical grant.
 * @param provider - FI route id.
 * @param signal - exact operation cancellation.
 * @returns validated remote model routes; errors never select a public or cached account.
 */
export async function loadCatalog(
  config: ConsoleOptions, grant: ConsoleGrant, provider: string, signal?: AbortSignal,
): Promise<ConsoleModel[]> {
  const deadline = AbortSignal.any([
    AbortSignal.timeout(config.requestTimeoutMs),
    ...signal === undefined ? [] : [signal],
  ])
  return project(await fetchCatalog(config, grant, new ModelRegistry(), deadline), provider, config)
}

/**
 * Authenticated catalogs of the signed-in account, reused for `catalogCacheMs` and shared by concurrent readers.
 * A failed load is never replaced by an earlier catalog, so errors still surface for the account that asked.
 */
export class CatalogCache {
  private readonly loaded = new Map<string, { catalog: Catalog; loadedAt: number }>()
  private readonly loading = new Map<string, Promise<Catalog>>()
  private readonly registry: ModelRegistry

  /** @param warn - receives operator-facing registry warnings. */
  constructor(warn?: (message: string) => void) { this.registry = new ModelRegistry(warn) }

  /**
   * Resolve the account's routes.
   * @param config - settings frozen for one operation.
   * @param grant - already refreshed canonical grant; its account and organization select the cache entry.
   * @param provider - FI route id.
   * @param signal - cancellation of this caller's wait; the shared load keeps running for other readers.
   * @param fresh - bypass a cached catalog, as user-initiated discovery does; a load already in flight is joined.
   * @returns validated remote model routes.
   */
  async models(
    config: ConsoleOptions, grant: ConsoleGrant, provider: string, signal?: AbortSignal, fresh = false,
  ): Promise<ConsoleModel[]> {
    signal?.throwIfAborted()
    const key = JSON.stringify([config.server, grant.accountId, grant.orgId ?? null])
    const hit = this.loaded.get(key)
    if (!fresh && hit !== undefined && Date.now() - hit.loadedAt < config.catalogCacheMs) return project(hit.catalog, provider, config)
    let work = this.loading.get(key)
    if (work === undefined) {
      const load = fetchCatalog(config, grant, this.registry, AbortSignal.timeout(config.requestTimeoutMs))
        .then((catalog) => {
          this.loaded.delete(key)
          this.loaded.set(key, { catalog, loadedAt: Date.now() })
          for (const oldest of this.loaded.keys()) {
            if (this.loaded.size <= MAX_CACHED_CATALOGS) break
            this.loaded.delete(oldest)
          }
          return catalog
        })
        .finally(() => { this.loading.delete(key) })
      this.loading.set(key, load)
      work = load
    }
    return project(await awaitWithAbort(work, signal), provider, config)
  }
}
