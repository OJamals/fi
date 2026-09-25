/** Public types and errors for subscription-native web search. */

import { WebError } from '@deepseek-ai/dsh-web'

/** Subscription families with a proven native search transport. */
export type SubscriptionSearchFamily = 'codex' | 'grok' | 'antigravity' | 'claude'

/** Provider failure retaining an upstream HTTP status when one exists. */
export class SubscriptionSearchError extends WebError {
  /** HTTP status returned by the subscription endpoint. */
  readonly status?: number

  /**
   * @param message - safe diagnostic without provider response content.
   * @param code - machine-routable failure class.
   * @param status - upstream HTTP status, when the failure has one.
   * @param options - chained cause.
   */
  constructor(message: string, code: string, status?: number, options?: ErrorOptions) {
    super(message, code, options)
    if (status !== undefined) this.status = status
  }
}
