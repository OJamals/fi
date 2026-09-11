/**
 * The Models page's subscription sign-in section: one area listing every
 * provider whose value is a subscription the user already holds — Claude
 * Pro/Max, ChatGPT Plus/Pro, SuperGrok/X Premium, and Antigravity — with its
 * live state, and driving the whole flow (sign in, then adopt) from one
 * button.
 *
 * This is the ONLY sign-in surface this package renders. Earlier revisions
 * also extended each provider row through `settings.models.provider-card`;
 * that put credential UI between the model rows, which read as clutter, so
 * the section now carries everything: unsigned providers offer "Add",
 * signed-in ones show their state with "Sign in again" and "Remove
 * sign-in". The provider rows themselves stay plain route rows — the
 * settings route is what makes a provider servable, and it belongs to the
 * page's own list.
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
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

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
 * One row of the section: one subscription provider, its state dot, and the
 * actions that state allows. Both sign-in verbs route through the same
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
  const method = row.methods[0]?.label ?? row.label
  return (
    <div className={styles['row']}>
      <span className={styles['identity']}>
        <span className={row.stored ? styles['dotSignedIn'] : styles['dotSignedOut']} aria-hidden="true" />
        <span className={styles['label']}>{row.label}</span>
        <span className={styles['stateText']}>
          {row.stored ? t('stateSignedIn') : t('stateSignedOut')}
        </span>
      </span>
      <span className={styles['actions']}>
        {adoptable
          ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => { void controller.signInAndAdopt(row.key) }}
            >
              {row.stored ? t('signInAgain', { method }) : t('adoptAction', { provider: row.label })}
            </Button>
          )
          : null}
        {row.stored
          ? (
            <Button
              variant="ghost"
              disabled={busy}
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

  // The section exists only when the Host actually registered at least one
  // of the offered flows: a composition without the adapters shows nothing,
  // which is the self-correcting half of the OFFERED whitelist. Every
  // registered row renders in both directions of the stored flag, so a
  // revoke anywhere (this section, another tab, a CLI) turns the row back
  // into a sign-in offer on the next load rather than a dead end.
  if (state.status !== 'ready' || state.rows.length === 0) return null
  const adoptableKeys = new Set(state.adoptEntries.map(entry => entry.key))
  const busy = state.attempt !== null

  return (
    <section className={styles['section']} aria-label={t('footerTitle')}>
      <h3 className={styles['title']}>{t('footerTitle')}</h3>
      <p className={styles['intro']}>{t('footerHint')}</p>
      <ul className={styles['rows']}>
        {state.rows.map(row => (
          <li key={row.key} className={styles['rowLi']}>
            <SubscriptionRow
              row={row}
              adoptable={adoptableKeys.has(row.key)}
              controller={controller}
              t={t}
              busy={busy}
            />
          </li>
        ))}
      </ul>
      {state.attempt === null
        ? null
        : (
          <div className={styles['attempt']}>
            <AttemptView attempt={state.attempt} controller={controller} t={t} />
          </div>
        )}
      {state.adopted === null
        ? null
        : (
          <div className={styles['adopted']} role="status" aria-live="polite">
            <p className={styles['adoptedTitle']}>
              {t('footerAdopted', {
                provider: state.rows.find(row => row.key === state.adopted?.key)?.label
                  ?? state.adopted.key,
                route: routeVerb(state.adopted.route, t),
                count: String(state.adopted.models.length),
              })}
            </p>
            {state.adopted.models.length === 0
              ? null
              : (
                <div>
                  <h4 className={styles['modelsTitle']}>{t('footerModelsTitle')}</h4>
                  <ol className={styles['modelsList']}>
                    {state.adopted.models.map((id: string) => <li key={id} className={styles['modelRow']}>{id}</li>)}
                  </ol>
                </div>
              )}
          </div>
        )}
    </section>
  )
}
