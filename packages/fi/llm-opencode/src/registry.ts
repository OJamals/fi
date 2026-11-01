/**
 * Public OpenCode model registry: the model metadata that completes an authenticated Console workspace overlay.
 * The request carries no credentials, organization headers, or redirects, and the registry never adds a provider
 * the authenticated Console did not list.
 */
import { z } from 'zod'
import { awaitWithAbort } from './protocol.ts'
import type { ConsoleOptions } from './protocol.ts'
import { registryOptionSchema } from './reasoning.ts'

/** Public registry document served by OpenCode. */
export const REGISTRY_URL = 'https://models.opencode.ai/api.json'
/** The registry is about 6 MiB of JSON; a larger body is not a registry. */
const MAX_REGISTRY_BYTES = 32 * 1024 * 1024
const MAX_WARNED_PROVIDERS = 100

const tolerant = <Schema extends z.ZodType>(schema: Schema) => schema.optional().catch(undefined)
const positive = tolerant(z.number().int().positive())
const textList = tolerant(z.array(z.string()))
const modelSchema = z.object({
  id: tolerant(z.string()), status: tolerant(z.string()),
  reasoning: tolerant(z.boolean()), reasoning_options: tolerant(z.array(registryOptionSchema)),
  limit: tolerant(z.object({ context: positive, output: positive })),
  modalities: tolerant(z.object({ input: textList, output: textList })),
  provider: tolerant(z.object({ npm: tolerant(z.string()), api: tolerant(z.string()) })),
})
const providerSchema = z.object({ npm: z.string(), api: tolerant(z.string()), models: z.record(z.string(), z.unknown()) })

/** Registry fields that completion reads; everything else is discarded when the document is parsed. */
export type RegistryModel = z.infer<typeof modelSchema>

/** One registry provider with its default package and endpoint. */
export interface RegistryProvider {
  npm: string
  api?: string | undefined
  models: Map<string, RegistryModel>
}

interface Snapshot {
  providers: Map<string, RegistryProvider>
  etag?: string | undefined
  lastModified?: string | undefined
  loadedAt: number
  /** The network is not tried again before this time. */
  refreshAt: number
}

/** Keep valid providers and models from an untrusted registry document. */
function parseRegistry(raw: unknown): Map<string, RegistryProvider> {
  const providers = new Map<string, RegistryProvider>()
  for (const [id, value] of Object.entries(z.record(z.string(), z.unknown()).parse(raw))) {
    const head = providerSchema.safeParse(value)
    if (!head.success) continue
    const models = new Map<string, RegistryModel>()
    for (const [modelId, entry] of Object.entries(head.data.models)) {
      const model = modelSchema.safeParse(entry)
      if (model.success) models.set(modelId, model.data)
    }
    providers.set(id, { npm: head.data.npm, api: head.data.api, models })
  }
  // A well-formed but empty or foreign document must not replace a good copy or silently empty every catalog.
  if (providers.size === 0) throw new Error('OpenCode model registry is invalid')
  return providers
}

async function readBounded(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks).toString('utf8')
    bytes += value.byteLength
    if (bytes > MAX_REGISTRY_BYTES) {
      await reader.cancel()
      throw new Error('OpenCode model registry exceeded 32 MiB')
    }
    chunks.push(value)
  }
}

async function fetchRegistry(config: ConsoleOptions, held: Snapshot | undefined): Promise<Snapshot> {
  // Validators let an unchanged registry cost one small 304.
  const headers = new Headers({ accept: 'application/json' })
  if (held?.etag !== undefined) headers.set('if-none-match', held.etag)
  if (held?.lastModified !== undefined) headers.set('if-modified-since', held.lastModified)
  const response = await fetch(REGISTRY_URL, { headers, redirect: 'error', signal: AbortSignal.timeout(config.requestTimeoutMs) })
  const now = Date.now()
  const validators = { etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined }
  if (response.status === 304 && held !== undefined) {
    await response.body?.cancel()
    return {
      ...held, etag: validators.etag ?? held.etag, lastModified: validators.lastModified ?? held.lastModified,
      loadedAt: now, refreshAt: now + config.registryCacheMs,
    }
  }
  if (!response.ok || response.body === null) throw new Error(`OpenCode model registry unavailable (${response.status})`)
  const providers = parseRegistry(JSON.parse(await readBounded(response.body)))
  return { providers, ...validators, loadedAt: now, refreshAt: now + config.registryCacheMs }
}

/**
 * Process-local registry copy owned by one adapter: fresh reads cost nothing, concurrent refreshes share one
 * request, and each caller's cancellation ends only its own wait.
 */
export class ModelRegistry {
  private snapshot: Snapshot | undefined
  private loading: Promise<Map<string, RegistryProvider>> | undefined
  private readonly warned = new Set<string>()

  /** @param warn - receives operator-facing warnings about stale registry data and providers it lacks. */
  constructor(private readonly warn: (message: string) => void = () => {}) {}

  /**
   * Read the registry, revalidating it when its copy is older than `registryCacheMs`.
   * @param config - settings frozen for the operation.
   * @param signal - cancellation of this caller's wait.
   * @returns validated providers; after a failed refresh, the previous copy while younger than `registryStaleMs`.
   */
  async load(config: ConsoleOptions, signal?: AbortSignal): Promise<Map<string, RegistryProvider>> {
    signal?.throwIfAborted()
    const held = this.snapshot
    if (held !== undefined && Date.now() < held.refreshAt) return held.providers
    if (this.loading === undefined) {
      this.loading = this.refresh(config, held).finally(() => { this.loading = undefined })
    }
    return awaitWithAbort(this.loading, signal)
  }

  /**
   * Warn once that the registry has no metadata for a provider whose models therefore stay unadvertised.
   * @param provider - Console provider id.
   */
  missing(provider: string): void {
    if (this.warned.has(provider) || this.warned.size >= MAX_WARNED_PROVIDERS) return
    this.warned.add(provider)
    this.warn(`OpenCode model registry has no metadata for provider ${JSON.stringify(provider.slice(0, 80))}; its models are omitted`)
  }

  private async refresh(config: ConsoleOptions, held: Snapshot | undefined): Promise<Map<string, RegistryProvider>> {
    try {
      const next = await fetchRegistry(config, held)
      this.snapshot = next
      return next.providers
    } catch (error) {
      if (held === undefined || Date.now() - held.loadedAt > config.registryStaleMs) throw error
      held.refreshAt = Date.now() + config.registryCacheMs
      this.warn(`OpenCode model registry refresh failed (${error instanceof Error ? error.message : 'unknown error'}); using the previous copy`)
      return held.providers
    }
  }
}
