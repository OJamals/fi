/**
 * The Models page's subscription sign-in section: one selector for providers
 * whose value is a subscription the user already holds — Claude Pro/Max,
 * ChatGPT Plus/Pro, SuperGrok/X Premium, and Antigravity. It shows the
 * selected provider's grant state and starts sign-in, adoption, and removal.
 *
 * The rows come from the Host's `list` joined to the package's OFFERED
 * whitelist, so a composition missing an adapter (or a pi-ai release that
 * drops a login) simply renders fewer rows; the adoptable join comes from
 * `listAdoptable`, whose scope→route map is what lets Antigravity render in
 * the same section despite living outside pi-ai's catalog.
 *
 * @module @fi/client-ui-model-signin/client
 */

import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SignInRow, SignInState } from './store.ts'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button, DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'

import { AttemptView } from './SignInCard.tsx'
import type { SignInStore } from './store.ts'
import type { SignInKey } from './locales.ts'
import styles from './SignInFooter.module.css'

/** Registration-side dependencies of {@link SignInFooter}. */
export interface SignInFooterInjected {
  /** The store the footer drives (begin/adopt/remove actions live on it). */
  controller: SignInStore
  /** Bound snapshot hook compartment; rendered as `useSnapshot`. */
  hooks: { snapshot: SignInStore['store'] }
  /** Copy lookups bound to this plugin's dictionary namespace. */
  t: (key: SignInKey, params?: Record<string, string>) => string
}

export type SignInFooterProps = Partial<InjectFace<SignInFooterInjected>>

/** Localized route verb: the one word that says whether the route was new. */
function routeVerb(token: 'created' | 'already' | 'skipped', t: SignInFooterInjected['t']): string {
  if (token === 'created') return t('footerRouteCreated')
  if (token === 'already') return t('footerRouteAlready')
  return t('footerRouteSkipped')
}

/**
 * The selected provider's state and actions. Both sign-in verbs route through the same
 * stream and chain the same adopt — on an already-routed provider adopt
 * answers `already`, so "Sign in again" needs no separate path.
 */
function SubscriptionRow({ row, adoptable, controller, t, busy }: {
  row: SignInRow
  adoptable: boolean
  controller: SignInStore
  t: SignInFooterInjected['t']
  busy: boolean
}): ReactNode {
  const rowBusy = busy || row.inFlight
  return (
    <div className={styles['row']}>
      <span className={styles['identity']}>
        <span className={row.stored ? styles['dotSignedIn'] : styles['dotSignedOut']} aria-hidden="true" />
        <span className={styles['stateText']}>
          {row.stored ? t('stateSignedIn') : t('stateSignedOut')}
        </span>
      </span>
      <span className={styles['actions']}>
        {adoptable
          ? (
            <Button
              variant="outline"
              disabled={rowBusy}
              aria-label={t(row.stored ? 'setupActionFor' : 'adoptActionFor', { provider: row.label })}
              onClick={() => { void (row.stored ? controller.adopt(row.key) : controller.signInAndAdopt(row.key)) }}
            >
              {row.stored ? t('setupAction') : t('adoptAction')}
            </Button>
          )
          : null}
        {row.stored
          ? (
            <Button
              variant="outline"
              disabled={rowBusy}
              aria-label={t('signInAgainFor', { provider: row.label })}
              onClick={() => { void controller.signInAndAdopt(row.key) }}
            >
              {t('signInAgain')}
            </Button>
          )
          : null}
        {row.stored
          ? (
            <Button
              variant="ghost"
              disabled={rowBusy}
              aria-label={t('removeSignInFor', { provider: row.label })}
              onClick={() => { void controller.remove(row.key) }}
            >
              {t('removeSignIn')}
            </Button>
          )
          : null}
      </span>
    </div>
  )
}

/**
 * The subscription sign-in area rendered below the Models page's rows.
 * @param props - this plugin's inject face; nothing until the store is ready.
 * @returns the footer section.
 */
export function SignInFooter(props: SignInFooterProps): ReactNode {
  const { controller, useSnapshot, t } = props
  /* v8 ignore next -- the renderer binds the inject face; a direct render
     without it simply shows nothing. */
  if (controller === undefined || useSnapshot === undefined || t === undefined) return null
  return <Bound controller={controller} useSnapshot={useSnapshot} t={t} />
}

/** The bound half, split so the snapshot hook runs after the inject-face guard. */
function Bound({ controller, useSnapshot, t }: {
  controller: SignInStore
  useSnapshot: InjectFace<SignInFooterInjected>['useSnapshot']
  t: SignInFooterInjected['t']
}): ReactNode {
  const state = useSnapshot((snapshot: SignInState) => snapshot)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [modelsOpen, setModelsOpen] = useState(false)
  const selectorId = useId()
  const activeAttemptKey = state.attempt !== null && (state.attempt.settled === null || state.attempt.adopting === true)
    ? state.attempt.key
    : null

  useEffect(() => {
    if (activeAttemptKey !== null && state.rows.some(row => row.key === activeAttemptKey)) setSelectedKey(activeAttemptKey)
  }, [activeAttemptKey, state.rows])

  useEffect(() => {
    if (state.adopted === null) return
    setSelectedKey(state.adopted.key)
    setModelsOpen(false)
  }, [state.adopted])

  // The section exists only when the Host actually registered at least one
  // of the offered flows: a composition without the adapters shows nothing,
  // which is the self-correcting half of the OFFERED whitelist. Every
  // registered row renders in both directions of the stored flag, so a
  // revoke anywhere (this section, another tab, a CLI) turns the row back
  // into a sign-in offer on the next load rather than a dead end.
  if (state.status === 'loading' || state.status === 'failed') {
    return (
      <section className={styles['section']} aria-label={t('footerTitle')}>
        <h3 className={styles['title']}>{t('footerTitle')}</h3>
        <p className={styles['intro']}>{t('footerHint')}</p>
        {state.status === 'loading'
          ? <p className={styles['loading']} role="status">{t('footerLoading')}</p>
          : (
            <div className={styles['error']} role="alert">
              <p>{t('footerLoadError', { message: state.error ?? t('failed') })}</p>
              <Button variant="outline" onClick={() => { void controller.load() }}>{t('retry')}</Button>
            </div>
          )}
      </section>
    )
  }
  if (state.status !== 'ready') return null
  const firstRow = state.rows[0]
  if (firstRow === undefined) return null
  const adoptableKeys = new Set(state.adoptEntries.map(entry => entry.key))
  const busy = state.busy === true || (state.attempt !== null && (state.attempt.settled === null || state.attempt.adopting === true))
  const attemptRow = state.attempt === null ? undefined : state.rows.find(row => row.key === state.attempt?.key)
  const selectedRow = (busy ? attemptRow : undefined)
    ?? state.rows.find(row => row.key === selectedKey)
    ?? state.rows.find(row => row.key === state.adopted?.key)
    ?? firstRow
  const adopted = state.adopted?.key === selectedRow.key ? state.adopted : null

  return (
    <section className={styles['section']} aria-label={t('footerTitle')}>
      <h3 className={styles['title']}>{t('footerTitle')}</h3>
      <p className={styles['intro']}>{t('footerHint')}</p>
      <div className={styles['controlsRow']} data-managed={selectedRow.stored ? 'true' : undefined}>
        <div className={styles['providerPicker']}>
          <label className={styles['pickerLabel']} htmlFor={selectorId}>{t('footerProvider')}</label>
          <select
            id={selectorId}
            name="fi-subscription-provider"
            className={styles['providerSelect']}
            data-fi-subscription-provider-select
            value={selectedRow.key}
            disabled={busy}
            onChange={(event) => {
              setSelectedKey(event.target.value)
              setModelsOpen(false)
            }}
          >
            {state.rows.map(row => <option key={row.key} value={row.key}>{row.label}</option>)}
          </select>
        </div>
        <div className={styles['selectedRow']}>
          <SubscriptionRow
            row={selectedRow}
            adoptable={adoptableKeys.has(selectedRow.key)}
            controller={controller}
            t={t}
            busy={busy}
          />
        </div>
      </div>
      {state.attempt === null
        ? null
        : (
          <div className={styles['attempt']}>
            <p className={styles['attemptLabel']} role="status">
              {t('footerAttempt', { provider: attemptRow?.label ?? state.attempt.key })}
            </p>
            <AttemptView attempt={state.attempt} controller={controller} t={t} />
          </div>
        )}
      {state.error === null
        ? null
        : (
          <div className={styles['error']} role="alert">
            {t('footerError', { message: state.error })}
          </div>
        )}
      {adopted === null
        ? null
        : (
          <div className={styles['adopted']} role="status" aria-live="polite">
            <p className={styles['adoptedTitle']}>
              {t('footerAdopted', {
                provider: selectedRow.label,
                route: routeVerb(adopted.route, t),
                count: String(adopted.models.length),
              })}
            </p>
            {adopted.models.length === 0
              ? null
              : (
                <DisclosureRow
                  icon={<span className={styles['modelsDisclosureIcon']} aria-hidden="true" />}
                  title={t('footerModelsTitle')}
                  open={modelsOpen}
                  expandable
                  expandOnRowClick
                  onToggle={() => { setModelsOpen(open => !open) }}
                  collapsedContent={<span className={styles['modelsCount']}>{String(adopted.models.length)}</span>}
                >
                  <ol className={styles['modelsList']}>
                    {adopted.models.map((id: string) => <li key={id} className={styles['modelRow']}>{id}</li>)}
                  </ol>
                </DisclosureRow>
              )}
          </div>
        )}
    </section>
  )
}
