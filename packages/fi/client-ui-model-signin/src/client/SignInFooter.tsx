/**
 * The Models page's footer area rendered by this plugin: a subscription
 * sign-in section that lists Claude Pro/Max and ChatGPT Plus/Pro even before
 * any provider route exists, and drives the whole flow — sign in, then adopt
 * — from one button.
 *
 * What it renders beyond what `SignInCard` renders per row: nothing about
 * credentials (the per-row card already covers that) but the adoption
 * outcome — the route the sign-in just materialized, and the models the
 * route now serves — because the route only appears on the page after the
 * Models section's own `settings/document-updated` refresh has had time, and
 * users adding a product subscription should see what landed without
 * scrolling for the row the section just re-rendered.
 *
 * @module @fi/client-ui-model-signin/client
 */

import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SignInState } from './store.ts'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AuthorizationAdoptEntry } from '@fi/api-authorization-controller/types'

import { AttemptView } from './SignInCard.tsx'
import type { SignInStore } from './store.ts'
import type { SignInKey } from './locales.ts'
import styles from './SignInFooter.module.css'

/** Registration-side dependencies of {@link SignInFooter}. */
export interface SignInFooterInjected {
  /** The store the footer drives (begin/adopt actions live on it). */
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

/** One row of the footer: a provider still missing its route. */
function AdoptRow({ entry, controller, t, busy }: {
  entry: AuthorizationAdoptEntry
  controller: SignInStore
  t: SignInFooterInjected['t']
  busy: boolean
}): ReactNode {
  return (
    <div className={styles['row']}>
      <span className={styles['identity']}>
        <span className={styles['dot']} aria-hidden="true" />
        <span className={styles['label']}>{entry.label}</span>
      </span>
      {/* The sign-in verb routes through the same stream as the row card
         does; the differences are `method: oauth` pinned and adopt chained
         onto a successful settlement. `busy` locks the second button the
         same way the row card locks `begin`. */}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => { void controller.signInAndAdopt(entry.key) }}
      >
        {t('adoptAction', { provider: entry.label })}
      </Button>
    </div>
  )
}

/**
 * The subscription sign-in area rendered below the Models page's rows and
 * above its footer.
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

  // Two facts gate this section: the page has resolved (rows come through
  // status from `load`), and the Host reported at least one adoptable
  // provider that has no stored grant yet. A done provider shows its adopted
  // banner below rather than a button, so the list can empty out without
  // hiding the banner's evidence for what just happened.
  if (state.status !== 'ready') return null
  const offerRows = state.rows.filter((row: SignInState['rows'][number]) => !row.stored)
  const outstanding = state.adoptEntries.filter((entry: AuthorizationAdoptEntry) => offerRows.some((row: SignInState['rows'][number]) => row.key === entry.key))
  const busy = state.attempt !== null

  return (
    <section className={styles['section']} aria-label={t('footerTitle')}>
      <h3 className={styles['title']}>{t('footerTitle')}</h3>
      <p className={styles['intro']}>{t('footerHint')}</p>
      <ul className={styles['rows']}>
        {outstanding.map((entry: AuthorizationAdoptEntry) => (
          <li key={entry.key} className={styles['rowLi']}>
            <AdoptRow entry={entry} controller={controller} t={t} busy={busy} />
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
                provider: outstanding.find((entry: AuthorizationAdoptEntry) => entry.key === state.adopted?.key)?.label
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
