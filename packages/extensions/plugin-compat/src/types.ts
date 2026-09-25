/** Public records for scoped Claude and Codex compatibility plugins. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Stable identity of one imported compatibility plugin. */
export type ManagedPluginId = Branded<'ManagedPluginId'>

/** Stable identity of a component declared by one imported plugin. */
export type ManagedPluginItemId = Branded<'ManagedPluginItemId'>

/** Persistent configuration plane selected by a plugin-management operation. */
export type ManagedPluginScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId }

/** Imported format that supplied a compatibility plugin. */
export type ManagedPluginOrigin = 'claude' | 'codex'

/** Component kinds the Harness can activate from an imported compatibility plugin. */
export type ManagedPluginItemKind = 'skill' | 'mcp' | 'hook'

/** Why a declared plugin component cannot activate in the Harness. */
export interface ManagedPluginDiagnostic {
  readonly code: 'unsupported-component' | 'unsupported-hook' | 'invalid-configuration' | 'activation-failed'
  readonly message: string
}

/** One declared compatibility component and its selected effective state. */
export interface ManagedPluginItem {
  readonly id: ManagedPluginItemId
  readonly kind: ManagedPluginItemKind
  readonly name: string
  readonly enabled: boolean
  readonly override?: boolean
  readonly diagnostics: readonly ManagedPluginDiagnostic[]
}

/** One local Claude or Codex plugin imported into a selected scope. */
export interface ManagedPlugin {
  readonly id: ManagedPluginId
  readonly name: string
  readonly origin: ManagedPluginOrigin
  readonly path: string
  readonly removable: boolean
  readonly enabled: boolean
  readonly override?: boolean
  readonly items: readonly ManagedPluginItem[]
  readonly diagnostics: readonly ManagedPluginDiagnostic[]
}

/** Scope snapshot used for a management mutation's optimistic-concurrency fence. */
export interface ManagedPluginSnapshot {
  readonly scope: ManagedPluginScope
  readonly revision: number
  readonly activation: 'new-session-required'
  readonly plugins: readonly ManagedPlugin[]
}

/** Result of a successful management mutation. */
export interface ManagedPluginMutation { readonly snapshot: ManagedPluginSnapshot }

/** Target whose workspace-local override is reset to its inherited global value. */
export type ManagedPluginOverrideTarget =
  | { readonly kind: 'plugin'; readonly pluginId: ManagedPluginId }
  | { readonly kind: ManagedPluginItemKind; readonly pluginId: ManagedPluginId; readonly itemId: ManagedPluginItemId }
