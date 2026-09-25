/**
 * The Antigravity model catalog as fi's surfaces see it.
 *
 * Two sources, one shape: the transport's static fallback list (shipped
 * `antigravity-*` identifiers plus the capture-derived AGY projection
 * targets), and — when a grant is stored — the live `fetchAvailableModels`
 * reply, already projected to the identifiers `agy models` prints. Both are
 * model ids the Cloud Code endpoint accepts; the request path's
 * `normalizeModel` maps every one of them to an upstream catalog key.
 *
 * Display names are derived, not stored: the id is the durable fact, the
 * name is presentation. A new id from a future live catalog still renders
 * sensibly because the derivation falls back to the id itself.
 *
 * @module @fi/llm-antigravity/catalog
 */

import { staticAntigravityModelIds } from './transport.ts'

/** One selectable Antigravity model. */
export interface AntigravityCatalogEntry {
  /** Model id accepted by the Cloud Code endpoint (post-`normalizeModel`). */
  readonly id: string
  /** Human-readable name for selectors. */
  readonly name: string
}

/**
 * Title-case one model id into a display name. Known families get their
 * marketing spelling; anything unknown keeps the id, which is always a
 * truthful — if plain — label.
 * @param id - a catalog model id.
 * @returns the display name.
 */
export function antigravityModelName(id: string): string {
  const stripped = id.replace(/^antigravity-/, '')
  const family = stripped.match(/^(gemini|claude|gpt-oss)-/)
  if (family === null) return id
  return stripped
    .replace(/^gemini-/, 'Gemini ')
    .replace(/^claude-/, 'Claude ')
    .replace(/^gpt-oss-/, 'GPT-OSS ')
    .replace(/-/g, ' ')
    .replace(/\b(\d) (\d)\b/g, '$1.$2')
    .replace(/\b\w/g, letter => letter.toUpperCase())
}

/**
 * The static catalog: every text or image model the transport can name without a
 * network call, in the transport's own order. Surfaces merge live catalog
 * ids ahead of this list when a grant makes `fetchAvailableModels`
 * reachable.
 */
export const ANTIGRAVITY_STATIC_CATALOG: readonly AntigravityCatalogEntry[] =
  staticAntigravityModelIds().map(id => ({ id, name: antigravityModelName(id) }))
