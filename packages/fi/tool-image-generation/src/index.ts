/** Opt-in FI image generation through stored subscription grants. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createModels } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { authContextFrom, credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveAntigravityGrant } from '@fi/llm-antigravity'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tools'
import { ImageToolOwner } from './tool.ts'
import type { ImageGenerationProvider, ImageGenerationTarget } from './types.ts'

export { ImageGenerationError } from './types.ts'
export type { ImageGenerationProvider, ImageGenerationTarget } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fi-tool-image-generation'

/** The tool requires registry, durable image storage, and execution-world filesystem services. */
export const inject = ['tools', 'attachments', 'fs', 'credentials']

/** Default whole-operation timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 180_000
/** Largest configurable whole-operation timeout in milliseconds. */
export const MAX_TIMEOUT_MS = 600_000
/** Default maximum decoded provider output bytes. */
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024
/** Largest configurable decoded provider output size. */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** Explicit subscription image targets and operation bounds. */
export interface Config {
  /** Provider selected when a tool call omits its provider argument. */
  defaultProvider: ImageGenerationProvider
  /** Explicit model id for each enabled provider. */
  targets: Partial<Record<ImageGenerationProvider, ImageGenerationTarget>>
  /** Whole filesystem/auth/network/storage operation timeout in milliseconds. */
  timeoutMs?: number
  /** Maximum decoded provider output bytes before attachment validation. */
  maxOutputBytes?: number
}

const Target = z.object({ imageModel: z.string().required() })

export const Config: z<Config> = z.object({
  defaultProvider: z.union(['codex', 'grok', 'antigravity'] as const).required(),
  targets: z.dict(Target).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  maxOutputBytes: z.number().step(1).min(1).max(MAX_OUTPUT_BYTES).default(DEFAULT_MAX_OUTPUT_BYTES),
})

interface ResolvedConfig {
  readonly defaultProvider: ImageGenerationProvider
  readonly targets: ReadonlyMap<ImageGenerationProvider, ImageGenerationTarget>
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved = Config(config)
  const allowed = new Set<ImageGenerationProvider>(['codex', 'grok', 'antigravity'])
  const entries = Object.entries(resolved.targets)
  if (entries.length === 0) throw new Error('tool-image-generation: targets must configure at least one provider')
  const targets = new Map<ImageGenerationProvider, ImageGenerationTarget>()
  for (const [provider, target] of entries) {
    if (!allowed.has(provider as ImageGenerationProvider)) {
      throw new Error(`tool-image-generation: unsupported target provider "${provider}"`)
    }
    if (target.imageModel.trim().length === 0) {
      throw new Error(`tool-image-generation: targets.${provider}.imageModel must be non-empty`)
    }
    targets.set(provider as ImageGenerationProvider, Object.freeze({ imageModel: target.imageModel }))
  }
  if (!targets.has(resolved.defaultProvider)) {
    throw new Error('tool-image-generation: defaultProvider must name a configured target')
  }
  return {
    defaultProvider: resolved.defaultProvider,
    targets,
    timeoutMs: resolved.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: resolved.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  }
}

/** Register one explicitly configured subscription-backed `image_gen` tool. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const models = createModels({
    credentials: credentialStoreFrom(ctx),
    authContext: authContextFrom(ctx),
  })
  for (const provider of builtinProviders()) models.setProvider(provider)
  const owner = new ImageToolOwner(ctx, {
    ...resolved,
    resolveOAuth: (provider, signal) => models.getAuth(provider, { signal }),
    resolveAntigravityGrant: signal => resolveAntigravityGrant(ctx, signal),
  })
  owner.register()
  ctx.effect(() => async () => { await owner.dispose() }, `${name}:active-operations`)
}
