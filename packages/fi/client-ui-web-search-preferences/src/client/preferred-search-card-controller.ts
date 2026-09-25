/** Controller face between Host settings/credentials and preferred-search presentation. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

type CredentialSetting =
  | 'apiKeyEnv'
  | 'exaApiKeyEnv'
  | 'perplexityApiKeyEnv'
  | 'parallelApiKeyEnv'
  | 'tavilyApiKeyEnv'
  | 'serperApiKeyEnv'
  | 'braveApiKeyEnv'

const DIRECT_PROVIDER_CREDENTIALS = {
  'deepseek-official': ['apiKeyEnv', 'DEEPSEEK_API_KEY'],
  'exa': ['exaApiKeyEnv', 'EXA_API_KEY'],
  'perplexity': ['perplexityApiKeyEnv', 'PERPLEXITY_API_KEY'],
  'parallel': ['parallelApiKeyEnv', 'PARALLEL_API_KEY'],
  'tavily': ['tavilyApiKeyEnv', 'TAVILY_API_KEY'],
  'serper': ['serperApiKeyEnv', 'SERPER_API_KEY'],
  'brave': ['braveApiKeyEnv', 'BRAVE_SEARCH_API_KEY'],
} as const satisfies Record<string, readonly [CredentialSetting, string]>

type DirectSearchProvider = keyof typeof DIRECT_PROVIDER_CREDENTIALS

/** Search engines available in FI's stable preferred-search router. */
export type PreferredSearchProvider = DirectSearchProvider | 'subscription-native'

/** Subscription-backed search families. */
export type SubscriptionProvider = 'codex' | 'grok' | 'antigravity' | 'claude'

/** Browser-visible Host settings; credential literals are excluded. */
export interface PreferredSearchSettings {
  provider: PreferredSearchProvider
  apiKeyEnv?: string
  exaApiKeyEnv?: string
  perplexityApiKeyEnv?: string
  parallelApiKeyEnv?: string
  tavilyApiKeyEnv?: string
  serperApiKeyEnv?: string
  braveApiKeyEnv?: string
  subscriptionProvider?: SubscriptionProvider
  subscriptionModel?: string
}

/** Render state supplied through the slot hook face. */
export interface PreferredSearchCardState {
  available: boolean
  writable: boolean
  dirty: boolean
  settingsDirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  provider: PreferredSearchProvider
  subscriptionProvider: SubscriptionProvider
  subscriptionModel: string
  apiKey: string
  credentialRef?: string
  apiKeyConfigured: boolean
  apiKeyWritable: boolean
  apiKeyChecking: boolean
}

/** Slot face consumed by the presentation component. */
export interface PreferredSearchCardFace {
  hooks: {
    /** Preferred-search snapshot bound by the renderer as `usePreferredSearchCard`. */
    preferredSearchCard: SnapshotStore<PreferredSearchCardState>
  }
  editProvider(provider: PreferredSearchProvider): void
  editSubscriptionProvider(provider: SubscriptionProvider): void
  editSubscriptionModel(model: string): void
  editApiKey(value: string): void
  save(): void
  discard(): void
  removeKey(): void
}

interface CredentialState {
  ref: string | undefined
  checked: boolean
  configured: boolean
  writable: boolean
}

interface Draft {
  provider?: PreferredSearchProvider
  subscriptionProvider?: SubscriptionProvider
  subscriptionModel?: string
  apiKey?: string
}

const DEFAULT_PROVIDER: PreferredSearchProvider = 'deepseek-official'
const DEFAULT_SUBSCRIPTION_PROVIDER: SubscriptionProvider = 'codex'

/**
 * Resolve the exact credential reference named by the selected provider settings.
 * @param settings - current Host-owned provider settings.
 * @param provider - provider whose credential reference is required.
 * @returns configured reference, default reference, or `undefined` for subscription search.
 */
export function credentialRefFor(
  settings: PreferredSearchSettings,
  provider: PreferredSearchProvider = settings.provider,
): string | undefined {
  if (provider === 'subscription-native') return undefined
  const [setting, fallback] = DIRECT_PROVIDER_CREDENTIALS[provider]
  return nonBlank(settings[setting]) ?? fallback
}

/** Own settings drafts, credential races, and the slot snapshot face. */
export class PreferredSearchCardController {
  private readonly store: SnapshotStore<PreferredSearchCardState>
  private readonly unsubscribe: () => void
  private draft: Draft = {}
  private credential: CredentialState = {
    ref: undefined,
    checked: false,
    configured: false,
    writable: true,
  }
  private saving = false
  private failed = false
  private credentialReadEpoch = 0
  private disposed = false

  /**
   * @param scope - the bound `fi-web-search-preferences` settings form.
   * @param ctx - client context supplying credential RPC.
   */
  constructor(
    private readonly scope: ConfigForm<PreferredSearchSettings>,
    private readonly ctx: ClientContext,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      this.publish()
      void this.readCredential()
    })
    void this.readCredential()
  }

  /** Stop settings updates and invalidate credential reads still in flight. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.credentialReadEpoch += 1
    this.unsubscribe()
  }

  /**
   * Build the hook and action face injected through the card slot.
   * @returns stable controller face consumed by the presentation component.
   */
  inject(): PreferredSearchCardFace {
    return {
      hooks: { preferredSearchCard: this.store },
      editProvider: (provider) => {
        this.draft.provider = provider
        delete this.draft.apiKey
        this.failed = false
        this.credential = {
          ref: credentialRefFor(this.settings(), provider),
          checked: false,
          configured: false,
          writable: true,
        }
        this.publish()
        void this.readCredential()
      },
      editSubscriptionProvider: (provider) => {
        this.draft.subscriptionProvider = provider
        this.failed = false
        this.publish()
      },
      editSubscriptionModel: (model) => {
        this.draft.subscriptionModel = model
        this.failed = false
        this.publish()
      },
      editApiKey: (value) => {
        this.draft.apiKey = value
        this.failed = false
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => {
        this.draft = {}
        this.failed = false
        this.publish()
        void this.readCredential()
      },
      removeKey: () => { void this.removeKey() },
    }
  }

  /**
   * Re-read when another browser surface changes the active reference.
   * @param ref - credential reference named by the invalidation event.
   */
  refreshCredential(ref: string): void {
    if (this.disposed) return
    if (ref !== credentialRefFor(this.settings(), this.provider())) return
    void this.readCredential()
  }

  private settings(): PreferredSearchSettings {
    return this.scope.getSnapshot().value ?? { provider: DEFAULT_PROVIDER }
  }

  private provider(): PreferredSearchProvider {
    return this.draft.provider ?? this.settings().provider
  }

  private subscriptionProvider(): SubscriptionProvider {
    return this.draft.subscriptionProvider
      ?? this.settings().subscriptionProvider
      ?? DEFAULT_SUBSCRIPTION_PROVIDER
  }

  private subscriptionModel(): string {
    return this.draft.subscriptionModel ?? this.settings().subscriptionModel ?? ''
  }

  private projection(): PreferredSearchCardState {
    const snapshot = this.scope.getSnapshot()
    const provider = this.provider()
    const credentialRef = credentialRefFor(this.settings(), provider)
    const apiKey = this.draft.apiKey ?? ''
    const settingsDirty = this.draft.provider !== undefined
      || this.draft.subscriptionProvider !== undefined
      || this.draft.subscriptionModel !== undefined
    const credentialKnown = credentialRef === undefined
      || (this.credential.ref === credentialRef && this.credential.checked)
    const invalid = provider === 'subscription-native'
      ? this.subscriptionModel().trim().length === 0
      : !credentialKnown || (!this.credential.configured && apiKey.trim().length === 0)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: settingsDirty || apiKey.trim().length > 0,
      settingsDirty,
      invalid,
      saving: this.saving,
      failed: this.failed,
      provider,
      subscriptionProvider: this.subscriptionProvider(),
      subscriptionModel: this.subscriptionModel(),
      apiKey,
      ...credentialRef === undefined ? {} : { credentialRef },
      apiKeyConfigured: credentialKnown && this.credential.configured,
      apiKeyWritable: credentialKnown && this.credential.writable,
      apiKeyChecking: credentialRef !== undefined && !credentialKnown,
    }
  }

  private async readCredential(): Promise<void> {
    if (this.disposed) return
    const epoch = ++this.credentialReadEpoch
    const ref = credentialRefFor(this.settings(), this.provider())
    if (ref === undefined) {
      this.credential = { ref: undefined, checked: true, configured: false, writable: false }
      this.failed = false
      this.publish()
      return
    }
    if (this.credential.ref !== ref) {
      this.credential = { ref, checked: false, configured: false, writable: true }
      this.publish()
    }
    const response = await this.ctx.remote.credentials.describe([ref]).catch(() => undefined)
    if (
      epoch !== this.credentialReadEpoch
      || ref !== credentialRefFor(this.settings(), this.provider())
    ) return
    if (response === undefined || !response.ok) {
      this.credential = { ref, checked: true, configured: false, writable: true }
      this.failed = true
      this.publish()
      return
    }
    const view = response.value[ref]
    this.credential = {
      ref,
      checked: true,
      configured: view?.configured ?? false,
      writable: view?.writable ?? true,
    }
    this.failed = false
    this.publish()
  }

  private async save(): Promise<void> {
    const state = this.projection()
    if (
      !state.dirty
      || state.invalid
      || this.saving
      || !state.available
      || (state.settingsDirty && !state.writable)
    ) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const ref = state.credentialRef
      if (ref !== undefined && state.apiKey.trim().length > 0) {
        const response = await this.ctx.remote.credentials.set(ref, state.apiKey.trim())
        if (!response.ok) throw response.error
        await this.readCredential()
        if (this.credential.ref !== ref || !this.credential.configured) {
          throw new Error(`credential ${ref} was not stored`)
        }
      }
      const ops = this.settingsOps(state)
      if (ops.length > 0) {
        await this.scope.mutate(ops, this.scope.getSnapshot().revision)
        if (!this.settingsLanded(state)) throw new Error('preferred-search settings were not stored')
      }
      this.draft = {}
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  private settingsOps(state: PreferredSearchCardState) {
    const ops = []
    if (this.draft.provider !== undefined) {
      ops.push({ op: 'set' as const, path: ['provider'], value: state.provider })
    }
    if (state.provider === 'subscription-native') {
      if (this.draft.subscriptionProvider !== undefined || this.draft.provider !== undefined) {
        ops.push({
          op: 'set' as const,
          path: ['subscriptionProvider'],
          value: state.subscriptionProvider,
        })
      }
      if (this.draft.subscriptionModel !== undefined || this.draft.provider !== undefined) {
        ops.push({ op: 'set' as const, path: ['subscriptionModel'], value: state.subscriptionModel.trim() })
      }
    }
    return ops
  }

  private settingsLanded(state: PreferredSearchCardState): boolean {
    const accepted = this.scope.getSnapshot().value
    if (accepted === undefined) return false
    if (this.draft.provider !== undefined && accepted.provider !== state.provider) return false
    if (state.provider !== 'subscription-native') return true
    if (
      (this.draft.subscriptionProvider !== undefined || this.draft.provider !== undefined)
      && accepted.subscriptionProvider !== state.subscriptionProvider
    ) return false
    return !(
      (this.draft.subscriptionModel !== undefined || this.draft.provider !== undefined)
      && accepted.subscriptionModel !== state.subscriptionModel.trim()
    )
  }

  private async removeKey(): Promise<void> {
    const ref = credentialRefFor(this.settings(), this.provider())
    if (ref === undefined || this.saving) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const response = await this.ctx.remote.credentials.unset(ref)
      if (!response.ok) throw response.error
      await this.readCredential()
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  private publish(): void {
    if (this.disposed) return
    this.store.set(this.projection())
  }
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}
