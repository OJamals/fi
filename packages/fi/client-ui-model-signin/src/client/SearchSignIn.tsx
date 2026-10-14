/** Search settings reuse the shared account authorization conversation. */

import { useId, useState } from 'react'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@fi/client-ui-web-search-preferences/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SignInFooterInjected } from './SignInFooter.tsx'
import { AttemptView } from './SignInCard.tsx'
import styles from './SignInFooter.module.css'

const PROVIDERS = {
  codex: 'openai-codex', grok: 'xai', claude: 'anthropic', antigravity: 'antigravity',
  'exa-oauth': 'exa-oauth', 'parallel-oauth': 'parallel-oauth', 'tavily-oauth': 'tavily-oauth', 'firecrawl-oauth': 'firecrawl-oauth',
} as const

/** Search-specific grants plus the model grants usable for native subscription search. */
export const SEARCH_SIGNIN_KEYS = [
  'llm-pi-ai/openai-codex', 'llm-pi-ai/xai', 'llm-pi-ai/anthropic', 'fi-antigravity/antigravity',
  'fi-search/exa-oauth', 'fi-search/parallel-oauth', 'fi-search/tavily-oauth', 'fi-search/firecrawl-oauth',
] as const

/**
 * Render OAuth controls only for search-capable registered providers.
 * @param props - selected search family and shared authorization store.
 * @returns account status, sign-in controls, and the active authorization conversation.
 */
export function SearchSignIn(props: Pick<PropsRuntime<'fi.search.sign-in'>, 'provider'> & InjectFace<SignInFooterInjected>) {
  const state = props.useSnapshot(snapshot => snapshot)
  const [selected, setSelected] = useState('')
  const id = useId()
  const { controller, t } = props
  const vendor = props.provider.endsWith('-oauth')
  const rows = state.rows.filter(row => Object.values(PROVIDERS).some(provider => provider === row.provider)
    && (props.provider === 'auto' ? !row.provider.endsWith('-oauth') : row.provider === PROVIDERS[props.provider]))
  const row = rows.find(candidate => candidate.key === selected) ?? rows[0]
  const busy = state.busy === true || (state.attempt !== null && state.attempt.settled === null)
  return (
    <section className={styles['section']} aria-label={t(vendor ? 'searchVendorTitle' : 'searchSignInTitle')}>
      <h3 className={styles['title']}>{t(vendor ? 'searchVendorTitle' : 'searchSignInTitle')}</h3>
      <p className={styles['intro']}>{t(vendor ? 'searchVendorHint' : 'searchSignInHint')}</p>
      {row === undefined
        ? <p role="status">{t(state.status === 'loading' || state.status === 'idle' ? 'footerLoading' : 'searchSignInUnavailable')}</p>
        : (
          <div className={styles['controlsRow']} data-managed={row.stored ? 'true' : undefined}>
            <div className={styles['providerPicker']}>
              <label className={styles['pickerLabel']} htmlFor={id}>{t('footerProvider')}</label>
              <select id={id} className={styles['providerSelect']} value={row.key} disabled={busy} onChange={(event) => { setSelected(event.target.value) }}>
                {rows.map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
              </select>
            </div>
            <div className={styles['selectedRow']}>
              <div className={styles['row']}>
                <span className={styles['identity']}>
                  <span className={row.stored ? styles['dotSignedIn'] : styles['dotSignedOut']} aria-hidden="true" />
                  <span className={styles['stateText']}>{t(row.stored ? 'stateSignedIn' : 'stateSignedOut')}</span>
                </span>
                <span className={styles['actions']}>
                  <Button variant="outline" disabled={busy || row.inFlight} onClick={() => { void controller.begin(row.key, 'oauth') }}>
                    {t(row.stored ? 'signInAgain' : 'searchSignInAction')}
                  </Button>
                  {vendor && row.stored ? <Button variant="ghost" disabled={busy || row.inFlight} onClick={() => { void controller.remove(row.key) }}>{t('removeSignIn')}</Button> : null}
                </span>
              </div>
            </div>
          </div>
        )}
      {state.error === null ? null : <div role="alert" className={styles['error']}>{state.error}<Button variant="outline" onClick={() => { void controller.load() }}>{t('retry')}</Button></div>}
      {state.attempt === null ? null : <div className={styles['attempt']}>
        <p role="status">{t('footerAttempt', { provider: state.rows.find(candidate => candidate.key === state.attempt?.key)?.label ?? state.attempt.key })}</p>
        <AttemptView attempt={state.attempt} controller={controller} t={t} />
      </div>}
    </section>
  )
}
