/**
 * The Antigravity sign-in store: one row, one attempt, one grant.
 *
 * Unlike the pi-ai card, which joins an OFFERED list against the Host's
 * registered flows, this card knows exactly one provider: Antigravity. It
 * appears when the Host has registered the `fi-antigravity/antigravity`
 * flow and no grant is stored, and disappears once one is.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { AuthorizationEntryView, AuthorizationFrameView } from '@fi/api-authorization-controller'

const KEY = 'fi-antigravity/antigravity'

export interface SignInPrompt {
  readonly id: number
  readonly kind: 'text' | 'secret' | 'select'
  readonly message: string
  readonly placeholder?: string
  readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[]
}

export interface SignInAttempt {
  readonly key: string
  readonly notice: { readonly message: string; readonly url?: string; readonly code?: string } | null
  readonly prompt: SignInPrompt | null
  readonly settled: {
    readonly status: 'authorized' | 'failed' | 'cancelled'
    readonly message?: string
    readonly route?: 'created' | 'already' | 'skipped'
  } | null
}

/** One sign-in row the card renders. */
export interface SignInRow {
  readonly key: string
  readonly provider: string
  readonly label: string
  readonly methods: readonly { readonly id: string; readonly label: string }[]
  readonly stored: boolean
  readonly inFlight: boolean
}

/** The card's whole snapshot. */
export interface SignInState {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed'
  readonly rows: readonly SignInRow[]
  readonly attempt: SignInAttempt | null
  readonly error: string | null
  readonly adoptEntries: readonly { readonly key: string; readonly label: string }[]
  readonly adopted: {
    readonly key: string
    readonly route: 'created' | 'already' | 'skipped'
    readonly models: readonly string[]
  } | null
}

const INITIAL: SignInState = {
  status: 'idle', rows: [], attempt: null, error: null, adoptEntries: [], adopted: null,
}

export class SignInStore {
  private state: SignInState = INITIAL
  private listeners = new Set<() => void>()
  private abort: AbortController | null = null

  constructor(private readonly ctx: ClientContext) {}

  get store(): { getSnapshot(): SignInState; subscribe(listener: () => void): () => void } {
    return {
      getSnapshot: () => this.state,
      subscribe: (listener) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }
  }

  private set(patch: Partial<SignInState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  async load(): Promise<void> {
    const remote = this.ctx.get('remote.authorization')
    if (remote === undefined) {
      this.set({ status: 'ready', rows: [], adoptEntries: [] })
      return
    }
    this.set({ status: 'loading' })
    try {
      const entries: AuthorizationEntryView[] = await remote.list()
      const entry = entries.find(e => e.key === KEY)
      const rows: SignInRow[] = entry === undefined ? [] : [{
        key: entry.key,
        provider: 'antigravity',
        label: entry.label,
        methods: entry.methods.filter(m => m.id === 'oauth'),
        stored: entry.stored,
        inFlight: entry.inFlight,
      }]
      const adoptEntries = rows.filter(r => !r.stored).map(r => ({ key: r.key, label: r.label }))
      this.set({ status: 'ready', rows, adoptEntries, error: null })
    } catch (error) {
      this.set({ status: 'failed', error: String(error) })
    }
  }

  async signIn(): Promise<void> {
    if (this.state.attempt !== null) return
    this.abort?.abort()
    this.abort = new AbortController()
    const remote = this.ctx.get('remote.authorization')
    if (remote === undefined) return

    this.set({ attempt: { key: KEY, notice: null, prompt: null, settled: null } })
    try {
      const stream = remote.begin({ key: KEY, method: 'oauth' }, this.abort.signal)
      for await (const frame of stream) {
        this.applyFrame(frame)
        if (frame.kind === 'settled' && frame.status === 'authorized') {
          const attemptBeforeAdopt = this.state.attempt
          if (attemptBeforeAdopt !== null) {
            const adopted = await remote.adopt(KEY)
            this.set({
              adopted: { key: KEY, route: adopted.route, models: adopted.models },
              attempt: {
                ...(attemptBeforeAdopt as SignInAttempt),
                settled: { status: 'authorized', route: adopted.route, message: adopted.models.join(', ') },
              },
            })
          }
        }
      }
    } catch (error) {
      const attempt = this.state.attempt
      if (attempt !== null) {
        if (this.abort.signal.aborted) {
          this.set({ attempt: { ...(attempt as SignInAttempt), settled: { status: 'cancelled' } } })
        } else {
          this.set({
            attempt: { ...(attempt as SignInAttempt), settled: { status: 'failed', message: String(error) } },
          })
        }
      }
    } finally {
      this.set({ attempt: this.state.attempt })
      await this.load()
    }
  }

  async cancel(): Promise<void> {
    const remote = this.ctx.get('remote.authorization')
    if (remote === undefined) return
    await remote.cancel(KEY)
    this.abort?.abort()
  }

  async revoke(): Promise<void> {
    const remote = this.ctx.get('remote.authorization')
    if (remote === undefined) return
    await remote.revoke(KEY)
    await this.load()
  }

  async answer(id: number, value: string): Promise<void> {
    const remote = this.ctx.get('remote.authorization')
    if (remote === undefined) return
    await remote.answer(KEY, id, value)
  }

  private applyFrame(frame: AuthorizationFrameView): void {
    if (frame.kind === 'notice') {
      const attempt = this.state.attempt
      if (attempt === null) return
      this.set({ attempt: { ...attempt, notice: { message: frame.message, url: frame.url, code: frame.code } } })
    } else if (frame.kind === 'prompt') {
      const p = frame.prompt
      const attempt = this.state.attempt
      if (attempt === null) return
      this.set({ attempt: { ...attempt, prompt: {
        id: frame.id,
        kind: p.kind,
        message: p.message,
        placeholder: 'placeholder' in p ? p.placeholder : undefined,
        options: 'options' in p ? p.options : undefined,
      } } })
    } else if (frame.kind === 'settled') {
      const attempt = this.state.attempt
      if (attempt === null) return
      this.set({ attempt: { ...attempt, settled: { status: frame.status, message: frame.message, route: frame.route } } })
    }
  }

  dispose(): void {
    this.abort?.abort()
    this.listeners.clear()
  }
}
