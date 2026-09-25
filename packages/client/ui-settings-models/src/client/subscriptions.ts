/** Available subscription routes for Models-page provider placement. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** OAuth routes contributed by mounted Models-page subscription interfaces. */
    modelSettingsSubscriptions: ModelSettingsSubscriptions
  }
}

/** Live route ids; configured profiles without an API-key reference render below the sign-in control. */
export class ModelSettingsSubscriptions extends Service {
  /** Mounted contributors' available OAuth routes. */
  readonly store: SnapshotStore<readonly string[]> = createSnapshotStore<readonly string[]>([])
  private readonly entries = new Set<{ ids: readonly string[] }>()

  /** @param ctx - Client root context. */
  constructor(ctx: Context) {
    super(ctx, 'modelSettingsSubscriptions')
  }

  /**
   * Register available OAuth route ids; disposal returns their profiles to the main list.
   * @param ids - non-empty unique route ids from one subscription interface.
   * @returns disposer for this contribution.
   */
  register(ids: readonly string[]): () => void {
    if (ids.some(id => id.trim().length === 0) || new Set(ids).size !== ids.length) {
      throw new Error('ui-settings-models: subscription provider ids must be non-empty and unique')
    }
    const entry = { ids }
    this.entries.add(entry)
    this.publish()
    return () => {
      this.entries.delete(entry)
      this.publish()
    }
  }

  private publish(): void {
    this.store.set([...new Set([...this.entries].flatMap(entry => [...entry.ids]))])
  }
}
