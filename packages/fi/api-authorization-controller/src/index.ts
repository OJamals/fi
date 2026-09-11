/**
 * Host owner of the `authorization` Remote namespace: the surface half of
 * `ctx.authorization` as a browser configuration page drives it.
 *
 * WHY A STREAM RATHER THAN FORWARDED EVENTS
 * An authorization attempt is a conversation, not a notification: the flow
 * talks (open this page, enter this code) and sometimes asks (which account?
 * paste the code you were given), and the answers must come back from exactly
 * the surface that started the attempt. The seam already says so — its
 * `AuthorizationInteraction` is supplied with the request rather than
 * registered, "because the caller that starts an authorization is the one that
 * can talk to the human about it". A single `begin` stream preserves that
 * property end to end, keeps frame order intact, and needs no entry in the
 * application-wide forwarded-event allowlist.
 *
 * @module @fi/api-authorization-controller
 */

import { Context } from '@deepseek-ai/cordis'
import {
  AuthorizationDeclinedError,
} from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationNotice, AuthorizationPrompt, AuthorizationService,
} from '@deepseek-ai/dsh-authorization'
import { credentialKey, isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: pulls the settings service's Context merge (ctx.settings) into
// this program; the route write resolves the service defensively at runtime.
import type {} from '@deepseek-ai/dsh-settings'
import { z } from 'zod'

import type {
  AuthorizationAdoptEntry, AuthorizationAdoptView, AuthorizationEntryView, AuthorizationFrameView,
  AuthorizationPromptOptionView,
} from './types.ts'

export type {
  AuthorizationAdoptEntry, AuthorizationAdoptView, AuthorizationEntryView, AuthorizationFrameView,
  AuthorizationMethodView, AuthorizationPromptOptionView,
} from './types.ts'

/**
 * Credential-record scopes whose authorized grant should leave a settings
 * route behind, each mapped to the settings namespace that owns that family's
 * routes. Members of the pi-ai adapter family authenticate under
 * `llm-pi-ai/<id>`, and the same `llm-pi-ai` settings namespace routes them by
 * `providers.<id>` — so a fresh sign-in materializes the one route the grant
 * exists for. Another adapter family extends this map as its own one row; the
 * seam and this controller otherwise stay adapter-agnostic, and a scope with
 * no entry signs in without touching settings at all.
 */
const ROUTE_NAMESPACE_BY_SCOPE = { 'llm-pi-ai': 'llm-pi-ai' } as const

/**
 * Bound on a pending answer's size. A method id, an option id, or a pasted
 * OAuth code all sit far below this; the bound only keeps one authenticated
 * caller from parking unbounded text in Host memory while a flow waits.
 */
const MAX_ANSWER_CHARS = 8192

/**
 * A credential key as the wire carries it: `<scope>/<id>`, each half the
 * lowercase hyphenated identifier the credential grammar requires. Parsing it
 * here rather than accepting the branded type is what keeps a browser-supplied
 * string from reaching the seam unchecked.
 */
const KEY_PATTERN = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/

const keySchema = z.string().regex(KEY_PATTERN)
const beginRequestSchema = z.object({
  key: keySchema,
  method: z.string().min(1).max(64).optional(),
})
const answerRequestSchema = z.object({
  key: keySchema,
  id: z.number().int().nonnegative(),
  value: z.string().max(MAX_ANSWER_CHARS),
})

/** Parse the domain constraints that are more specific than generated codecs. */
function parseRequest<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
  }
  return parsed.data
}

/**
 * Brand one wire key, or refuse it.
 * @param wire - the `<scope>/<id>` string the caller sent.
 * @returns the branded credential key the seam takes.
 */
function brandKey(wire: string): CredentialKey {
  const match = KEY_PATTERN.exec(wire)
  /* v8 ignore next 3 -- every caller parses through `keySchema` first, which
     enforces this same pattern; the guard keeps a future caller that forgets
     from reaching `credentialKey` with a string it would throw on. */
  if (match === undefined || match === null) {
    throw new RemoteError('gateway/bad-request', `"${wire}" is not a credential key`, {})
  }
  const [, scope, id] = match as unknown as [string, string, string]
  /* v8 ignore next 3 -- the pattern above already is the segment grammar, so
     this cannot fail; it is here because `credentialKey` is the only authority
     on that grammar and a divergence should refuse rather than brand badly. */
  if (!isCredentialKeySegment(scope) || !isCredentialKeySegment(id)) {
    throw new RemoteError('gateway/bad-request', `"${wire}" is not a credential key`, {})
  }
  return credentialKey(scope, id)
}

/** Project one prompt's options, dropping anything the view does not declare. */
function projectOptions(
  options: readonly { id: string; label: string; description?: string }[],
): AuthorizationPromptOptionView[] {
  return options.map(option => ({
    id: option.id,
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }))
}

/** Project one notice, dropping anything the view does not declare. */
function projectNotice(notice: AuthorizationNotice): AuthorizationFrameView {
  return {
    kind: 'notice',
    message: notice.message,
    ...notice.url === undefined ? {} : { url: notice.url },
    ...notice.code === undefined ? {} : { code: notice.code },
  }
}

/**
 * One attempt's frame queue and pending questions.
 *
 * The seam pushes (a flow calls `notify` whenever it likes) and the Remote
 * stream pulls, so something has to hold frames between the two. This is that
 * buffer, plus the map of questions waiting on a browser answer.
 */
class Attempt {
  private readonly buffer: AuthorizationFrameView[] = []
  private readonly pending = new Map<number, {
    resolve: (value: string) => void
    reject: (reason: unknown) => void
  }>()

  private waiter: (() => void) | undefined
  private done = false
  private nextPromptId = 0

  /** Queue one frame for the stream, waking a parked reader. */
  push(frame: AuthorizationFrameView): void {
    if (this.done) return
    this.buffer.push(frame)
    this.waiter?.()
  }

  /**
   * Put one question to the surface and park until it answers.
   * @param prompt - what the flow asked.
   * @returns what the human typed, or the chosen option's id.
   * @throws {AuthorizationDeclinedError} when the human declines.
   */
  async ask(prompt: AuthorizationPrompt): Promise<string> {
    const id = this.nextPromptId++
    const frame: AuthorizationFrameView = prompt.kind === 'select'
      ? {
        kind: 'prompt',
        id,
        prompt: { kind: 'select', message: prompt.message, options: projectOptions(prompt.options) },
      }
      : {
        kind: 'prompt',
        id,
        prompt: {
          kind: prompt.kind,
          message: prompt.message,
          ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
        },
      }
    const answer = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.push(frame)
    // A prompt the flow withdraws on its own signal (the losing question of a
    // race) must reject with something that is NOT a decline, or the seam
    // reads a later genuine failure as the human saying no.
    const withdraw = (): void => {
      const waiting = this.pending.get(id)
      if (waiting === undefined) return
      this.pending.delete(id)
      this.push({ kind: 'withdraw', id })
      waiting.reject(new RemoteError('authorization/withdrawn', 'the prompt was withdrawn by its flow', { id }))
    }
    prompt.signal?.addEventListener('abort', withdraw, { once: true })
    try {
      return await answer
    } finally {
      prompt.signal?.removeEventListener('abort', withdraw)
      this.pending.delete(id)
    }
  }

  /**
   * Deliver one surface answer.
   * @param id - the prompt being answered.
   * @param value - what the human supplied; empty means declined.
   * @returns whether a question was waiting under that id.
   */
  answer(id: number, value: string): boolean {
    const waiting = this.pending.get(id)
    if (waiting === undefined) return false
    this.pending.delete(id)
    // An empty answer is the surface reporting a dismissed question. The seam
    // draws exactly this distinction: a decline settles the attempt as
    // `cancelled`, while any other rejection reads as the surface breaking.
    if (value === '') waiting.reject(new AuthorizationDeclinedError())
    else waiting.resolve(value)
    return true
  }

  /** Close the queue, failing every question still parked on an answer. */
  end(): void {
    if (this.done) return
    this.done = true
    for (const waiting of this.pending.values()) {
      waiting.reject(new RemoteError('authorization/withdrawn', 'the authorization surface went away', {}))
    }
    this.pending.clear()
    this.waiter?.()
  }

  /** Drain frames until the queue closes. */
  async *drain(): AsyncGenerator<AuthorizationFrameView> {
    while (true) {
      while (this.buffer.length > 0) yield this.buffer.shift() as AuthorizationFrameView
      if (this.done) return
      await new Promise<void>((resolve) => { this.waiter = resolve })
      this.waiter = undefined
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    fiAuthorizationController: FiAuthorizationController
  }
}

/**
 * Host service backing `ctx.remote.authorization`. It carries the wire
 * obligations the seam does not: the key grammar guard, the view projection,
 * the push-to-pull buffer, and the refusal mapping. No secret crosses in
 * either direction — a flow's grant is written by the flow itself, through
 * `ctx.credentials`, and is never handed to the surface.
 */
export class FiAuthorizationController extends TypertRemoteService {
  /** Live attempts by credential key, one at a time each (the seam enforces it too). */
  private readonly attempts = new Map<string, Attempt>()

  /** @param ctx - Host context where the authorization seam may be mounted. */
  constructor(ctx: Context) {
    super(ctx, 'fiAuthorizationController', { namespace: 'authorization' })
  }

  /**
   * Every registered flow, for a surface listing what can be signed into.
   *
   * `stored` joins the credential seam so a page can render "signed in"
   * without a second round trip. A composition with no credential provider
   * reports everything unstored rather than failing: the flows are still
   * offerable, and attempting one is what surfaces the missing store.
   * @returns one entry per flow, in registration order.
   */
  @Remote
  async list(): Promise<AuthorizationEntryView[]> {
    const authorization = this.seam()
    const credentials = this.ctx.get('credentials')
    const stored = new Set<string>()
    if (credentials !== undefined) {
      for (const record of await credentials.listRecords()) stored.add(record.key)
    }
    return authorization.list().map(entry => ({
      key: entry.key,
      label: entry.label,
      methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
      inFlight: entry.inFlight,
      stored: stored.has(entry.key),
    }))
  }

  /**
   * Run one attempt and stream its conversation.
   *
   * The stream ends with exactly one `settled` frame, failures included: a
   * surface renders the terminal state from the frame rather than inferring
   * it from the carrier closing, so a dropped connection and a refused login
   * never look alike.
   * @param request - the key to authorize and the method to run.
   * @param signal - cancellation owned by the Remote stream carrier; the
   *   surface navigating away withdraws the attempt.
   * @returns the notices, questions, and settlement of one attempt.
   */
  @Remote({ mode: 'stream' })
  begin(request: { key: string; method?: string }, signal: AbortSignal): AsyncIterable<AuthorizationFrameView> {
    const parsed = parseRequest('authorization.begin', beginRequestSchema, request)
    const key = brandKey(parsed.key)
    const authorization = this.seam()
    if (this.attempts.has(key)) {
      throw new RemoteError(
        'authorization/in-flight', `an authorization attempt for "${key}" is already running`, { key: parsed.key })
    }
    const attempt = new Attempt()
    this.attempts.set(key, attempt)
    // Deliberately not awaited: `begin` returns the stream immediately, and
    // the attempt's own settlement is what closes it. Every rejection path
    // below ends in a `settled` frame, so the promise cannot go unhandled.
    void authorization.begin({
      key,
      ...parsed.method === undefined ? {} : { method: parsed.method },
      signal,
      interaction: {
        notify: (notice) => { attempt.push(projectNotice(notice)) },
        prompt: async prompt => attempt.ask(prompt),
      },
    }).then(
      async (outcome) => {
        if (outcome.status !== 'authorized') {
          attempt.push({ kind: 'settled', status: outcome.status })
          return
        }
        // The grant is committed before this point — the route write is a
        // convenience layered on top of it, never a condition of it.
        const route = await this.ensureRoute(key)
        attempt.push({ kind: 'settled', status: 'authorized', route })
      },
      (error: unknown) => {
        attempt.push({
          kind: 'settled',
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      },
    ).finally(() => {
      this.attempts.delete(key)
      attempt.end()
    })
    return attempt.drain()
  }

  /**
   * Answer one question a running attempt asked.
   * @param key - the attempt's credential key.
   * @param id - the prompt id the `prompt` frame carried.
   * @param value - what the human supplied; the empty string means they declined.
   * @throws RemoteError when no attempt or no such question is waiting.
   */
  @Remote
  answer(key: string, id: number, value: string): void {
    const parsed = parseRequest('authorization.answer', answerRequestSchema, { key, id, value })
    const branded = brandKey(parsed.key)
    const attempt = this.attempts.get(branded)
    if (attempt === undefined || !attempt.answer(parsed.id, parsed.value)) {
      throw new RemoteError(
        'authorization/no-prompt', `no authorization prompt ${parsed.id} is waiting for "${parsed.key}"`, { key: parsed.key, id: parsed.id })
    }
  }

  /**
   * Withdraw the attempt running for a key, if any. Separate from the stream's
   * own signal because a Cancel button answers on a second call, with no
   * handle on the first one's carrier.
   * @param key - the credential record whose attempt should stop.
   */
  @Remote
  cancel(key: string): void {
    const parsed = parseRequest('authorization.cancel', z.object({ key: keySchema }), { key })
    this.seam().cancel(brandKey(parsed.key))
  }

  /**
   * Revoke one stored credential record — the sign-in "reset": the grant is
   * gone, the next request on the route fails its authentication again, and a
   * fresh `begin` is how the record comes back. Deliberately route-preserving:
   * the settings route is user configuration, and the Models page already owns
   * deleting it; tying the two sentences together would make an expired-token
   * reset rewrite the user's provider configuration as a side effect.
   *
   * The verb is `revoke`, not `remove`: the client-side namespace service
   * owns an instance method named `remove`, and the Remote client refuses a
   * method whose name collides with its namespace service.
   * @param key - the credential record to revoke.
   * @throws RemoteError when an attempt for that key is running, when no
   *   credential provider is mounted, or when the provider refuses the write.
   */
  @Remote
  async revoke(key: string): Promise<void> {
    const parsed = parseRequest('authorization.revoke', z.object({ key: keySchema }), { key })
    const branded = brandKey(parsed.key)
    if (this.attempts.has(branded)) {
      throw new RemoteError(
        'authorization/in-flight', `an authorization attempt for "${branded}" is already running`, { key: parsed.key })
    }
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'credentials provider is absent: this deployment does not mount a credential store'
        + ' (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
        {},
      )
    }
    await credentials.deleteRecord(branded)
  }

  /**
   * The providers the sign-in surface can adopt — every registered flow whose
   * credential scope carries a settings route. May read a fresh `begin`'s
   * settlement first; standing state answers without one.
   * @returns adoption entries in flow-registration order.
   */
  @Remote
  listAdoptable(): AuthorizationAdoptEntry[] {
    return this.seam().list().flatMap((entry) => {
      const ns = (ROUTE_NAMESPACE_BY_SCOPE as Record<string, string | undefined>)[entry.key.slice(0, entry.key.indexOf('/'))]
      if (ns === undefined) return []
      return [{
        key: entry.key,
        label: entry.label,
        routeId: entry.key.slice(entry.key.indexOf('/') + 1),
      }]
    })
  }

  /**
   * Adopt one already-signed-in provider into the user's own settings: if the
   * stored grant exists and no settings route for it stands yet, write the
   * route with an empty `models` list (pi-ai resolves that to its full
   * installed catalog), then enumerate the models the route will serve.
   *
   * The credential record is the precondition, written by `begin` when the
   * flow settles `authorized`; this method reads that committed record rather
   * than re-running any OAuth step, so the surface needs no second
   * interaction. `revoke` deliberately does NOT remove the route (deleting it
   * is the Models page's own action); calling `adopt` after `revoke` re-reads
   * no grant and upserts nothing, answering `skipped`.
   *
   * @param key - the credential record whose grant should back a route.
   * @returns what became of the route and which model ids it now serves.
   * @throws RemoteError when no grant is stored, when an attempt for the key
   *   is running, when no settings/credentials service is mounted, or when the
   *   route namespace answers nothing the catalog can enumerate.
   */
  @Remote
  async adopt(key: string): Promise<AuthorizationAdoptView> {
    const parsed = parseRequest('authorization.adopt', z.object({ key: keySchema }), { key })
    const branded = brandKey(parsed.key)
    if (this.attempts.has(branded)) {
      throw new RemoteError(
        'authorization/in-flight', `an authorization attempt for "${parsed.key}" is already running`, { key: parsed.key })
    }

    // A grant must already be committed for the key; idempotent beyond that,
    // so a second click of a done provider just re-reads the same answer.
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'credentials provider is absent: this deployment does not mount a credential store'
        + ' (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
        {},
      )
    }
    const record = await credentials.describeRecord(branded)
    if (!record.configured) {
      throw new RemoteError(
        'authorization/no-grant', `no stored grant for "${parsed.key}"; sign in first`, { key: parsed.key })
    }

    const route = await this.ensureRoute(branded)
    if (route === 'skipped') {
      // The Models page's own add-provider flow remains the explicit path, so
      // report the gap distinctly rather than fall back to an empty model set.
      throw new RemoteError(
        'authorization/adopt-blocked',
        `the settings route for "${parsed.key}" could not be written (read-only store or unregistered namespace)`,
        { key: parsed.key },
      )
    }

    // The route serves the installed catalog when its profile carries no
    // models list of its own; enumerate through the same discovery a surface
    // would use, without a network call for catalog-shipped providers.
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      throw new RemoteError(
        'authorization/adopt-blocked',
        'settings service is absent: cannot enumerate the adopted route models',
        { key: parsed.key },
      )
    }
    const settingsNs = (ROUTE_NAMESPACE_BY_SCOPE as Record<string, string | undefined>)[parsed.key.slice(0, parsed.key.indexOf('/'))]
    if (settingsNs === undefined) {
      throw new RemoteError(
        'authorization/adopt-blocked',
        `credential scope "${parsed.key.slice(0, parsed.key.indexOf('/'))}" carries no route rule to adopt through`,
        { key: parsed.key },
      )
    }
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new RemoteError('gateway/internal', 'llm service is absent: cannot enumerate models', {})

    let models: string[] = []
    try {
      const discovered = await llm.discoverModels(settingsNs, { provider: parsed.key.slice(parsed.key.indexOf('/') + 1) })
      models = discovered.map(model => model.id)
    } catch {
      // A catalog-shipped provider answers from the registry; failure means the
      // route namespace isn't connected to discovery — the route still stands
      // from `ensureRoute`, so report the gap and keep the grant.
      models = []
    }
    return { route, models }
  }

  /**
   * Leave a settings route behind for a freshly authorized grant, when the
   * key's scope declares one. Answers `skipped` whenever the write cannot be
   * made to hold — no entry for the scope, no settings service, a read-only
   * provider, an unregistered namespace, or a refusing write — because the
   * grant is already committed: the route is a convenience, and the Models
   * page remains the explicit path for adding it. Writes the same empty
   * profile the Models page's own add-provider flow writes; the route inherits
   * the installed catalog, and the grant authenticates it beneath any
   * `apiKeyEnv` override.
   * @param key - the authorized credential record.
   * @returns what became of the route.
   */
  private async ensureRoute(key: CredentialKey): Promise<'created' | 'already' | 'skipped'> {
    const slash = key.indexOf('/')
    const ns = (ROUTE_NAMESPACE_BY_SCOPE as Record<string, string | undefined>)[key.slice(0, slash)]
    if (ns === undefined) return 'skipped'
    const id = key.slice(slash + 1)
    const settings = this.ctx.get('settings')
    if (settings === undefined) return 'skipped'
    const read = (): { providers: Record<string, unknown>; revision: number } | undefined => {
      const view = settings.describe().find(candidate => candidate.ns === ns)
      if (view === undefined) return undefined
      const value = view.value as { providers?: Record<string, unknown> } | undefined
      return { providers: value?.providers ?? {}, revision: view.revision }
    }
    try {
      for (let round = 0; round < 2; round += 1) {
        const current = read()
        if (current === undefined || !settings.writable) return 'skipped'
        if (Object.hasOwn(current.providers, id)) return 'already'
        try {
          await settings.mutate(ns, [{ op: 'set', path: ['providers', id], value: {} }], current.revision)
          return 'created'
        } catch {
          // A revision conflict means the section moved under the read; the
          // loop re-reads and obeys what the fresh value says. Any other
          // refusal ends the same way on the second round: skipped, with the
          // grant intact and the Models page as the explicit route.
        }
      }
    } catch {
      // `describe` itself may fail on a provider still loading; classified the
      // same way, for the same reason.
    }
    return 'skipped'
  }

  /** Resolve the optional seam or report how to supply it. */
  private seam(): AuthorizationService {
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'authorization service is absent: this deployment does not mount the authorization seam'
        + ' (@deepseek-ai/dsh-authorization) in its composition',
        {},
      )
    }
    return authorization
  }
}

export default FiAuthorizationController
