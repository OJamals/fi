/**
 * Wire-safe authorization-controller types. Free of cordis and service
 * imports so the browser type chain can consume them without loading a Host
 * Context augmentation, matching the convention every `./types` face in this
 * repository follows.
 *
 * The vocabulary here is deliberately a restatement of
 * `@deepseek-ai/dsh-authorization/types` rather than a re-export of it: what
 * crosses the wire is a projection (an `AbortSignal` cannot be serialized, and
 * a `CredentialKey` is a branded string the browser must hold as a plain one),
 * so the two shapes are related but not identical. Keeping them separate is
 * what lets the seam evolve its in-process contract without changing the
 * protocol, and vice versa.
 *
 * @module @fi/api-authorization-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * A second surface asked to authorize a key an attempt is already running
     * for. The seam refuses rather than joining the two, because they would be
     * prompting different humans through the same flow.
     */
    'authorization/in-flight': {
      /** The credential key whose attempt is already running. */
      readonly key: string
    }
    /**
     * An answer arrived for a question that is no longer waiting — the attempt
     * ended, or the flow withdrew the question first.
     */
    'authorization/no-prompt': {
      /** The credential key the answer named. */
      readonly key: string
      /** The prompt id the answer named. */
      readonly id: number
    }
    /**
     * A question was retired before it was answered: the flow withdrew it (the
     * losing side of a race), or the surface holding the attempt went away.
     * Deliberately NOT a decline — the seam reads a decline as the human
     * saying no, which would mask a later genuine failure.
     */
    'authorization/withdrawn': {
      /** The prompt id, when one question was withdrawn rather than all of them. */
      readonly id?: number
    }
  }
}

/** One way a flow can obtain its credential, as a surface offers it. */
export interface AuthorizationMethodView {
  /** Flow-owned identifier, echoed back when the surface picks this method. */
  id: string
  /** User-facing label for the sign-in button. */
  label: string
}

/**
 * A registered flow as the Models page sees it.
 *
 * `key` is the credential record the flow writes, carried as a plain string:
 * the browser never brands it, and the Host re-brands it on the way back in.
 */
export interface AuthorizationEntryView {
  /** The credential record this flow writes, e.g. `llm-pi-ai/anthropic`. */
  key: string
  /** User-facing name of what is being authorized, e.g. `Anthropic`. */
  label: string
  /** The methods this flow offers, most preferred first. */
  methods: readonly AuthorizationMethodView[]
  /** Whether an attempt for this key is running right now, in any surface. */
  inFlight: boolean
  /** Whether a credential record for this key is already stored. */
  stored: boolean
}

/** One choice offered by a `select` prompt. */
export interface AuthorizationPromptOptionView {
  /** Value the surface returns when this option is chosen. */
  id: string
  /** User-facing label. */
  label: string
  /** Optional extra context a capable surface renders. */
  description?: string
}

/**
 * One frame of a running attempt.
 *
 * The stream is the whole of the conversation: a flow's notices, its
 * questions, and its settlement all arrive here, in order, on the same
 * carrier that `begin` opened. Delivering them this way rather than through a
 * forwarded Host event keeps the exchange addressed to exactly the surface
 * that started it — which is what the seam's per-request
 * `AuthorizationInteraction` already assumes — and means no global event
 * allowlist has to learn this namespace exists.
 */
export type AuthorizationFrameView =
  /**
   * Progress, or an instruction the human must act on. A `url` is a page to
   * open; a `code` is what to type there. Never carries a secret.
   */
  | {
    readonly kind: 'notice'
    readonly message: string
    readonly url?: string
    readonly code?: string
  }
  /**
   * A question the flow cannot answer for itself. The surface replies by
   * calling `answer` with this `id`; until it does, the flow is parked.
   * `secret` differs from `text` only in presentation — the surface masks it
   * and keeps it out of logs.
   */
  | {
    readonly kind: 'prompt'
    /** Correlates the reply; unique within one attempt. */
    readonly id: number
    readonly prompt:
      | { readonly kind: 'text'; readonly message: string; readonly placeholder?: string }
      | { readonly kind: 'secret'; readonly message: string; readonly placeholder?: string }
      | {
        readonly kind: 'select'
        readonly message: string
        readonly options: readonly AuthorizationPromptOptionView[]
      }
  }
  /**
   * A question withdrawn by the flow before it was answered — a flow racing a
   * typed code against a browser callback retiring the losing question. The
   * surface drops the prompt; the attempt continues.
   */
  | { readonly kind: 'withdraw'; readonly id: number }
  /**
   * How the attempt ended. Always the last frame, and always present: the
   * stream never ends without one, so a surface can render a terminal state
   * without inferring it from the carrier closing.
   */
  | {
    readonly kind: 'settled'
    readonly status: 'authorized' | 'cancelled' | 'failed'
    /** The Host's own diagnostic, present only for `failed`. */
    readonly message?: string
    /**
     * What became of the provider's settings route on a successful sign-in.
     * Present only for `authorized`, and only when the key's scope carries a
     * route rule: `created` when the route did not exist and now does,
     * `already` when it existed before the attempt, `skipped` when no settings
     * service could commit one (absent, read-only, or refusing) — in which
     * case the grant is still stored and the route can be added by hand.
     */
    readonly route?: 'created' | 'already' | 'skipped'
  }
