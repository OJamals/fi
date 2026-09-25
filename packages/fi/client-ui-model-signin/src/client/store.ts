/**
 * Sign-in card store: the registered authorization flows joined to the
 * provider rows the Models page renders, plus the live state of at most one
 * running attempt.
 *
 * The Host stays the single fact source. `list()` answers which flows exist
 * and which already hold a stored credential; an attempt's whole conversation
 * arrives on the stream `begin()` opened, and the card re-renders from each
 * frame. Nothing here caches a credential, and no secret is held in this
 * state — a typed answer goes straight back out over `answer()` and is
 * dropped.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  AuthorizationAdoptEntry, AuthorizationEntryView, AuthorizationFrameView,
} from '@fi/api-authorization-controller/types'

/** The credential-record scope the pi-ai adapter family writes under. */
const PI_AI_SCOPE = 'llm-pi-ai'

/**
 * The provider ids this card offers a sign-in for, and the order it offers
 * them in.
 *
 * Scoped deliberately. The pi-ai catalog registers a flow for every installed
 * provider — about forty, most of them api-key-only — and surfacing all of
 * them here would bury the subscription logins this card exists for
 * behind a wall of rows the Models page already handles as API-key fields.
 * These are the ones whose value is a subscription the user already pays
 * for and cannot otherwise reach: an OAuth grant, not a key they could type.
 * The fourth entry is the Antigravity adapter family's own scope; one
 * section renders every subscription sign-in, so no provider gets a second
 * section of its own.
 *
 * Adding a provider is a one-line change here, and a flow absent from the
 * Host (an older pi-ai, a composition without the adapter) simply does not
 * appear — the join below keeps this list advisory, never authoritative.
 */
export const SUBSCRIPTION_PROVIDER_IDS = [
  'anthropic', 'openai-codex', 'xai', 'antigravity',
] as const

const OFFERED = SUBSCRIPTION_PROVIDER_IDS.map(provider => provider === 'antigravity'
  ? 'fi-antigravity/antigravity'
  : `${PI_AI_SCOPE}/${provider}`)

/** One question the running attempt is waiting on. */
export interface SignInPrompt {
  /** Correlates the reply; unique within one attempt. */
  readonly id: number
  readonly kind: 'text' | 'secret' | 'select'
  readonly message: string
  readonly placeholder?: string
  readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[]
}

/** What the card knows about one running attempt. */
export interface SignInAttempt {
  /** The credential key being authorized. */
  readonly key: string
  /** The most recent notice, or null before the flow has said anything. */
  readonly notice: { readonly message: string; readonly url?: string; readonly code?: string } | null
  /** The question waiting on the human, or null when none is. */
  readonly prompt: SignInPrompt | null
  /** Set once the attempt ends; the card renders a terminal state from it. */
  readonly settled: {
    readonly status: 'authorized' | 'cancelled' | 'failed'
    readonly message?: string
    /** What became of the provider's settings route, present after a successful sign-in. */
    readonly route?: 'created' | 'already' | 'skipped'
  } | null
  /** Whether the successful sign-in is still being adopted into Models settings. */
  readonly adopting?: boolean
}

/** One sign-in row the card renders. */
export interface SignInRow {
  /** The credential record the flow writes, e.g. `llm-pi-ai/anthropic`. */
  readonly key: string
  /** The pi-ai provider id, which is also the settings route key. */
  readonly provider: string
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** The methods the flow offers, most preferred first. */
  readonly methods: readonly { readonly id: string; readonly label: string }[]
  /** Whether a credential record for this key is already stored. */
  readonly stored: boolean
  /** Whether an attempt for this key is running, in this surface or another. */
  readonly inFlight: boolean
}

/** The card's whole snapshot. */
export interface SignInState {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed'
  /** The offered flows the Host actually registered, in {@link OFFERED} order. */
  readonly rows: readonly SignInRow[]
  /** The attempt this surface is running, or null. */
  readonly attempt: SignInAttempt | null
  /** Why the last load failed, or null. */
  readonly error: string | null
  /** Whether this surface owns an unfinished authorization, adoption, or revoke operation. */
  readonly busy?: boolean
  /**
   * Providers the sign-in surface can adopt into a settings route, in flow
   * order. Modeled separately from `rows` because adoption needs the route
   * id, which only the Host knows; either list may lag the other one load.
   */
  readonly adoptEntries: readonly AuthorizationAdoptEntry[]
  /**
   * The last completed adoption — the route it left and the models the route
   * now serves — or null before anything has been adopted this session.
   */
  readonly adopted: {
    readonly key: string
    readonly route: 'created' | 'already' | 'skipped'
    readonly models: readonly string[]
  } | null
}

const INITIAL: SignInState = {
  status: 'idle', rows: [], attempt: null, error: null, busy: false, adoptEntries: [], adopted: null,
}

/**
 * Select and order the offered flows out of everything the Host registered.
 * @param entries - every registered flow.
 * @returns the offered rows, in {@link OFFERED} order, skipping absent flows.
 */
export function selectOfferedRows(entries: readonly AuthorizationEntryView[]): SignInRow[] {
  const byKey = new Map(entries.map(entry => [entry.key, entry]))
  const rows: SignInRow[] = []
  for (const key of OFFERED) {
    const entry = byKey.get(key)
    if (entry === undefined) continue
    // An offered flow with no OAuth method is not what this card is for: the
    // Models page already collects an API key for it as an ordinary field,
    // and showing a second way to type the same key would be two doors to one
    // room. Codex is oauth-only; Anthropic offers both and keeps the OAuth.
    const methods = entry.methods.filter(method => method.id === 'oauth')
    if (methods.length === 0) continue
    rows.push({
      key: entry.key,
      provider: entry.key.slice(entry.key.indexOf('/') + 1),
      label: entry.label,
      methods: methods.map(method => ({ id: method.id, label: method.label })),
      stored: entry.stored,
      inFlight: entry.inFlight,
    })
  }
  return rows
}

/**
 * Fold one stream frame into the running attempt.
 * @param attempt - the attempt as it stands.
 * @param frame - what the Host just sent.
 * @returns the attempt after the frame.
 */
export function applyFrame(attempt: SignInAttempt, frame: AuthorizationFrameView): SignInAttempt {
  switch (frame.kind) {
    case 'notice':
      return {
        ...attempt,
        notice: {
          message: frame.message,
          ...frame.url === undefined ? {} : { url: frame.url },
          ...frame.code === undefined ? {} : { code: frame.code },
        },
      }
    case 'prompt':
    {
      const prompt = frame.prompt
      const placeholder = prompt.kind === 'select' ? undefined : prompt.placeholder
      return {
        ...attempt,
        prompt: {
          id: frame.id,
          kind: prompt.kind,
          message: prompt.message,
          ...placeholder === undefined
            ? {}
            : { placeholder },
          ...prompt.kind === 'select' ? { options: prompt.options } : {},
        },
      }
    }
    case 'withdraw':
      // Only the question actually on screen is retired; a withdraw racing a
      // newer prompt must not blank the newer one.
      return attempt.prompt?.id === frame.id ? { ...attempt, prompt: null } : attempt
    default:
      return {
        ...attempt,
        prompt: null,
        settled: {
          status: frame.status,
          ...frame.message === undefined ? {} : { message: frame.message },
          ...frame.route === undefined ? {} : { route: frame.route },
        },
      }
  }
}

/** The card's store: one snapshot, one attempt at a time. */
export class SignInStore {
  /** The snapshot the card renders from (uSES-safe store). */
  readonly store: SnapshotStore<SignInState> = createSnapshotStore<SignInState>(INITIAL)

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /** Withdraws the running attempt's stream. */
  private running: AbortController | undefined

  /** Every user operation owns a number that retires its later publications. */
  private operation = 0

  /** @param ctx - the page plugin's context, whose `remote.authorization` namespace carries the flows. */
  constructor(private readonly ctx: ClientContext) {}

  /**
   * Refresh the offered rows from the Host.
   * @param preserveError - retain an action diagnostic while refreshing its row state.
   */
  async load(preserveError = false): Promise<void> {
    const generation = ++this.generation
    const current = this.store.getSnapshot()
    this.store.set({
      ...current,
      status: current.status === 'ready' ? 'ready' : 'loading',
      error: preserveError ? current.error : null,
    })
    try {
      const response = await this.ctx.remote.authorization.list()
      if (generation !== this.generation) return
      if (!response.ok) {
        const state = this.store.getSnapshot()
        this.store.set({ ...state, status: state.rows.length === 0 ? 'failed' : 'ready', error: response.error.message })
        return
      }
      // The adopt list rides its own call because it may exist without any
      // flow's in-flight/stored facts changing: the scope→namespace map is a
      // Host constant, and the Models page's own writes do not move what the
      // authorization seam registered.
      const adoptResponse = await this.ctx.remote.authorization.listAdoptable()
      if (generation !== this.generation) return
      const rows = selectOfferedRows(response.value)
      const state = this.store.getSnapshot()
      const adopted = state.adopted !== null && rows.some(row => row.key === state.adopted?.key && row.stored)
        ? state.adopted
        : null
      this.store.set({
        ...state,
        status: 'ready',
        error: preserveError ? state.error : adoptResponse.ok ? null : adoptResponse.error.message,
        rows,
        adoptEntries: adoptResponse.ok ? adoptResponse.value : state.adoptEntries,
        adopted,
      })
    } catch (error: unknown) {
      if (generation !== this.generation) return
      const state = this.store.getSnapshot()
      this.store.set({
        ...state,
        status: state.rows.length === 0 ? 'failed' : 'ready',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Begin one attempt and consume its conversation to the end.
   * @param key - the credential record to authorize.
   * @param method - the method to run; defaults to the flow's first.
   */
  async begin(key: string, method?: string): Promise<void> {
    await this.drive(key, method, false)
  }

  /**
   * The footer surface's whole flow: run the OAuth sign-in for a provider
   * (device code, paste, whatever the flow asks), then if it settles
   * `authorized` chain the adopt on the stored grant. The attempt's own
   * `authorized` settlement is what decides the second call is legal — this
   * method does not re-read credential state, and `revoke` between `begin`
   * and here would make `adopt` report `no-grant` honestly.
   * @param key - the credential record to authorize and adopt.
   */
  async signInAndAdopt(key: string): Promise<void> {
    await this.drive(key, 'oauth', true)
  }

  /**
   * Run one attempt to completion: set the attempt on the snapshot, consume
   * its frames, then adopts a successful OAuth grant when requested. The
   * operation number owns the complete chain, including the refresh and
   * adoption, so a dismissed or superseded attempt cannot publish afterward.
   * @param key - the credential record to authorize.
   * @param method - the method to run, or undefined for the flow's first.
   * @param adopt - whether an authorized settlement should add its provider.
   */
  private async drive(key: string, method: string | undefined, adopt: boolean): Promise<void> {
    // A running attempt or adoption locks the surface. A settled attempt with
    // no pending adoption does not, so it does not leave other rows disabled.
    const standing = this.store.getSnapshot()
    if (
      standing.busy === true
      || (standing.attempt !== null && (standing.attempt.settled === null || standing.attempt.adopting === true))
    ) return
    const operation = ++this.operation
    const controller = new AbortController()
    this.running = controller
    this.store.set({
      ...standing,
      attempt: { key, notice: null, prompt: null, settled: null, adopting: false },
      busy: true,
      // A new attempt supersedes whatever an earlier provider's adopt left
      // on screen: keeping it would read as this attempt's outcome.
      adopted: null,
      error: null,
    })
    let settlement: SignInAttempt['settled'] = null
    try {
      const stream = this.ctx.remote.authorization.begin(
        { key, ...method === undefined ? {} : { method } },
        controller.signal,
      )
      for await (const frame of stream) {
        const state = this.store.getSnapshot()
        // A dismissed card abandons its attempt; frames still in flight are
        // not ours to fold into whatever the user opened next.
        if (operation !== this.operation || state.attempt === null || state.attempt.key !== key) return
        const attempt = applyFrame(state.attempt, frame)
        settlement = attempt.settled
        this.store.set({ ...state, attempt })
      }
    } catch (error: unknown) {
      const state = this.store.getSnapshot()
      if (controller.signal.aborted) return
      if (operation !== this.operation || state.attempt === null || state.attempt.key !== key) return
      settlement = { status: 'failed', message: error instanceof Error ? error.message : String(error) }
      this.store.set({
        ...state,
        attempt: {
          ...state.attempt,
          prompt: null,
          settled: settlement,
        },
      })
    } finally {
      if (this.running === controller) this.running = undefined
      if (operation !== this.operation) return
      const state = this.store.getSnapshot()
      if (settlement === null && state.attempt !== null && state.attempt.key === key) {
        settlement = { status: 'failed', message: 'authorization flow ended without a result' }
        this.store.set({ ...state, attempt: { ...state.attempt, prompt: null, settled: settlement } })
      }
      if (adopt && settlement?.status === 'authorized') {
        const current = this.store.getSnapshot()
        if (current.attempt !== null && current.attempt.key === key) {
          this.store.set({ ...current, attempt: { ...current.attempt, adopting: true } })
        }
      }
      await this.load()
      if (operation !== this.operation) return
      if (adopt && settlement?.status === 'authorized') await this.adoptForOperation(key, operation)
      if (operation !== this.operation) return
      const current = this.store.getSnapshot()
      this.store.set({
        ...current,
        busy: false,
        attempt: current.attempt?.key === key ? { ...current.attempt, adopting: false } : current.attempt,
      })
    }
  }

  /**
   * Answer the question the running attempt is waiting on.
   * @param value - what the human supplied; the empty string declines.
   */
  async answer(value: string): Promise<void> {
    const state = this.store.getSnapshot()
    const attempt = state.attempt
    if (attempt?.prompt == null) return
    const operation = this.operation
    const id = attempt.prompt.id
    // Cleared before the round trip: the question is answered from the
    // human's point of view, and leaving it on screen invites a second submit
    // that the Host would refuse as `authorization/no-prompt`.
    this.store.set({ ...state, attempt: { ...attempt, prompt: null } })
    try {
      const response = await this.ctx.remote.authorization.answer(attempt.key, id, value)
      if (operation !== this.operation) return
      if (response.ok) return
      const current = this.store.getSnapshot()
      if (current.attempt?.key === attempt.key && current.attempt.prompt === null && current.attempt.settled === null) {
        this.store.set({ ...current, error: response.error.message, attempt: { ...current.attempt, prompt: attempt.prompt } })
      }
    } catch (error: unknown) {
      if (operation !== this.operation) return
      const current = this.store.getSnapshot()
      if (current.attempt?.key === attempt.key && current.attempt.prompt === null && current.attempt.settled === null) {
        this.store.set({
          ...current,
          error: error instanceof Error ? error.message : String(error),
          attempt: { ...current.attempt, prompt: attempt.prompt },
        })
      }
    }
  }

  /** Withdraw the running attempt, if any. */
  async cancel(): Promise<void> {
    const attempt = this.store.getSnapshot().attempt
    if (attempt === null) return
    const operation = this.operation
    try {
      const response = await this.ctx.remote.authorization.cancel(attempt.key)
      if (operation !== this.operation) return
      if (!response.ok) this.store.set({ ...this.store.getSnapshot(), error: response.error.message })
    } catch (error: unknown) {
      if (operation !== this.operation) return
      this.store.set({ ...this.store.getSnapshot(), error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Adopt one already-signed-in provider into the Models page: write its
   * settings route if absent and enumerate the models the route then serves.
   * The grant must already exist (a settled `begin` wrote it); the adopt is
   * idempotent past that point, so a click after an earlier successful adopt
   * just refreshes the same answer.
   * @param key - the credential record whose provider should be added.
   * @returns the adopt outcome, or undefined when the call itself failed.
   */
  async adopt(key: string): Promise<void> {
    if (this.store.getSnapshot().busy === true) return
    const operation = ++this.operation
    this.store.set({ ...this.store.getSnapshot(), busy: true, adopted: null, error: null })
    await this.adoptForOperation(key, operation)
    if (operation === this.operation) this.store.set({ ...this.store.getSnapshot(), busy: false })
  }

  /** Publish one adoption response only while its initiating operation owns the snapshot. */
  private async adoptForOperation(key: string, operation: number): Promise<void> {
    try {
      const response = await this.ctx.remote.authorization.adopt(key)
      if (operation !== this.operation) return
      if (!response.ok) {
        this.store.set({ ...this.store.getSnapshot(), status: 'ready', adopted: null, error: response.error.message })
        return
      }
      const state = this.store.getSnapshot()
      this.store.set({
        ...state,
        status: 'ready',
        error: null,
        adopted: { key, route: response.value.route, models: response.value.models },
      })
    } catch (error: unknown) {
      if (operation !== this.operation) return
      this.store.set({
        ...this.store.getSnapshot(),
        status: 'ready',
        adopted: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Reset one provider's sign-in: the stored grant is revoked on the Host,
   * the route stays (deleting it is the Models page's own action), and the
   * rows reload to show the provider offers a sign-in again. The reload is
   * in a `finally` so a refused or failed revoke never leaves this surface
   * rendering the stale stored state it just asked the user to act on.
   * @param key - the credential record to revoke.
   */
  async remove(key: string): Promise<void> {
    if (this.store.getSnapshot().busy === true) return
    const operation = ++this.operation
    this.store.set({ ...this.store.getSnapshot(), busy: true, error: null })
    let failure: string | null = null
    try {
      const response = await this.ctx.remote.authorization.revoke(key)
      if (!response.ok) failure = response.error.message
      else this.store.set({ ...this.store.getSnapshot(), adopted: null })
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      if (operation !== this.operation) return
      if (failure !== null) this.store.set({ ...this.store.getSnapshot(), error: failure })
      await this.load(failure !== null)
      if (operation === this.operation) this.store.set({ ...this.store.getSnapshot(), busy: false })
    }
  }

  /** Dismiss a settled attempt and retire any adoption that still belongs to it. */
  dismiss(): void {
    const state = this.store.getSnapshot()
    if (state.attempt === null) return
    ++this.operation
    this.running?.abort()
    this.running = undefined
    this.store.set({ ...state, attempt: null, busy: false })
  }

  /** Withdraw anything in flight; the plugin's disposer calls this. */
  dispose(): void {
    ++this.generation
    ++this.operation
    this.running?.abort()
    this.running = undefined
  }
}
