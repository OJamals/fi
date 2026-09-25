/** Client-owned presentation list for subscription model routes. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Subscription route ids contributed by installed client plugins. */
    modelSubscriptions: ModelSubscriptionProviders
  }
}

/** Display-only subscription route registry consumed by the composer picker. */
export class ModelSubscriptionProviders extends Service {
  /** Live provider ids; an open picker re-renders when contributions change. */
  readonly store: SnapshotStore<readonly string[]> = createSnapshotStore<readonly string[]>([])
  private readonly entries = new Set<{ ids: readonly string[] }>()

  /** @param ctx - client root context. */
  constructor(ctx: Context) {
    super(ctx, 'modelSubscriptions')
  }

  /**
   * Register route ids for the bottom picker section. No Host catalog or selection is changed.
   * @param ids - non-empty provider route ids; blanks and duplicates fail at registration.
   * @returns disposer that removes this contribution from the visible section.
   */
  register(ids: readonly string[]): () => void {
    if (ids.some(id => id.trim().length === 0) || new Set(ids).size !== ids.length) {
      throw new Error('ui-model-selection: subscription provider ids must be non-empty and unique')
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
