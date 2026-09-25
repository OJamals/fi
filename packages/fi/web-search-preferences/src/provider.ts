/** Stable FI routing over unchanged DeepSeek Harness search providers. */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import type { PreferredSearchSettings } from './types.ts'

/** Provider id selected once by FI composition. */
export const FI_PREFERRED_SEARCH_PROVIDER_ID = 'fi-preferred-search'

/** A provider returned for one snapshotted search operation. */
export interface ResolvedSearchProvider extends WebSearchProvider {
  /** Optional operation-scoped cleanup. */
  dispose?(): void | Promise<void>
}

/** Dependencies kept explicit so routing semantics can be tested without network I/O. */
export interface PreferredSearchProviderOptions {
  /** Read the settings section authoritative for the next operation. */
  readonly resolveConfig: () => PreferredSearchSettings
  /** Resolve the selected unchanged provider from one frozen settings snapshot. */
  readonly resolveProvider: (config: PreferredSearchSettings, signal: AbortSignal) => Promise<ResolvedSearchProvider>
}

/** One stable registry entry whose delegate is selected per search operation. */
export class PreferredSearchProvider implements WebSearchProvider {
  readonly id = FI_PREFERRED_SEARCH_PROVIDER_ID
  private readonly lifecycle = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly options: PreferredSearchProviderOptions) {}

  /**
   * This check performs no credential or network I/O.
   * @returns whether this stable router still accepts operations.
   */
  available(): boolean {
    return !this.disposed
  }

  /**
   * Freeze preference before async credential resolution, then run only that delegate.
   * @param request - upstream provider-neutral search request.
   * @param callerSignal - caller cancellation combined with plugin lifecycle cancellation.
   * @returns unchanged upstream provider result.
   */
  search(request: WebSearchRequest, callerSignal?: AbortSignal): Promise<WebSearchResult> {
    if (this.disposed) {
      return Promise.reject(new WebError('preferred search provider is disposed', 'WEB_ABORTED'))
    }
    const operation = this.run(request, callerSignal)
    this.active.add(operation)
    void operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation),
    )
    return operation
  }

  /**
   * Abort and await every active operation before plugin teardown completes.
   * @returns settlement after all operations and delegate cleanup settle.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = this.drain()
    this.lifecycle.abort(new Error('preferred search provider disposed'))
    return this.disposal
  }

  private async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled(this.active)
    }
  }

  private async run(request: WebSearchRequest, callerSignal?: AbortSignal): Promise<WebSearchResult> {
    const signal = callerSignal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([callerSignal, this.lifecycle.signal])
    const config = structuredClone(this.options.resolveConfig())
    let provider: ResolvedSearchProvider | undefined
    try {
      provider = await this.options.resolveProvider(config, signal)
      if (signal.aborted) {
        throw signal.reason ?? new WebError('preferred search provider aborted', 'WEB_ABORTED')
      }
      if (!provider.available()) {
        throw new WebError(
          `preferred web search provider "${config.provider}" is unavailable`,
          'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
        )
      }
      return await provider.search(request, signal)
    } finally {
      await provider?.dispose?.()
    }
  }
}
