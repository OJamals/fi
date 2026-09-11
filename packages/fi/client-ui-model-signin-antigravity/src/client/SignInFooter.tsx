/**
 * The Models page's footer area rendered by this plugin: an Antigravity
 * sign-in section that appears when the Host has registered the flow and no
 * grant is stored yet, and drives the whole flow — sign in, then adopt —
 * from one button.
 *
 * Unlike the pi-ai card, this one only uses the footer: Antigravity is not
 * in pi-ai's catalog, so there are no pi-ai provider cards to extend.
 *
 * @module @fi/client-ui-model-signin-antigravity/client
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { SignInState, SignInStore } from './store.ts'
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

/**
 * The Antigravity sign-in area rendered below the Models page's rows and
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

  // Two facts gate this section: the page has resolved, and the Host
  // reported the Antigravity flow with no stored grant yet. A done provider
  // shows its adopted banner below rather than a button.
  if (state.status !== 'ready') return null
  const hasRow = state.rows.length > 0
  const busy = state.attempt !== null

  return (
    <section className={styles['section']} aria-label={t('title')}>
      <h3 className={styles['title']}>{t('title')}</h3>
      <p className={styles['intro']}>{t('hint')}</p>
      {hasRow && state.attempt === null && state.adopted === null && (
        <div className={styles['row']}>
          <span className={styles['identity']}>
            <span className={styles['dot']} aria-hidden="true" />
            <span className={styles['label']}>Antigravity</span>
          </span>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => { void controller.signIn() }}
          >
            {t('signIn')}
          </Button>
        </div>
      )}
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
              {t('adopted', { route: state.adopted.route, count: String(state.adopted.models.length) })}
            </p>
          </div>
        )}
    </section>
  )
}

/** One attempt in flight: notices, prompts, and the settled outcome. */
function AttemptView({ attempt, controller, t }: {
  attempt: NonNullable<SignInState['attempt']>
  controller: SignInStore
  t: SignInFooterInjected['t']
}): ReactNode {
  if (attempt.settled !== null) {
    return (
      <div className={styles['settled']}>
        <p className={styles['settledMessage']}>
          {attempt.settled.status === 'authorized' && t('signedIn')}
          {attempt.settled.status === 'cancelled' && t('cancelled')}
          {attempt.settled.status === 'failed' && `${t('failed')} ${attempt.settled.message ?? ''}`}
        </p>
        {attempt.settled.status === 'authorized' && attempt.settled.route !== undefined && (
          <p className={styles['settledRoute']}>
            {t('adopted', { route: attempt.settled.route, count: String(attempt.settled.message?.split(', ').length ?? 0) })}
          </p>
        )}
        <Button variant="ghost" onClick={() => { void controller.load() }}>
          {t('close')}
        </Button>
      </div>
    )
  }

  return (
    <div className={styles['conversation']}>
      {attempt.notice === null
        ? null
        : (
          <div className={styles['notice']}>
            <p>{attempt.notice.message}</p>
            {attempt.notice.url !== undefined && (
              <p>
                <a href={attempt.notice.url} target="_blank" rel="noopener noreferrer">
                  {attempt.notice.url}
                </a>
              </p>
            )}
            {attempt.notice.code !== undefined && (
              <p className={styles['code']}>{attempt.notice.code}</p>
            )}
          </div>
        )}
      {attempt.prompt === null
        ? null
        : (
          <div className={styles['prompt']}>
            <p>{attempt.prompt.message}</p>
            <PromptInput prompt={attempt.prompt} controller={controller} t={t} />
          </div>
        )}
      <Button variant="ghost" onClick={() => { void controller.cancel() }}>
        {t('cancel')}
      </Button>
    </div>
  )
}

/** The input for one prompt: text, secret, or select. */
function PromptInput({ prompt, controller, t }: {
  prompt: NonNullable<SignInState['attempt']>['prompt']
  controller: SignInStore
  t: SignInFooterInjected['t']
}): ReactNode {
  if (prompt === null) return null
  const [value, setValue] = useState('')

  if (prompt.kind === 'select') {
    return (
      <div className={styles['promptInput']}>
        <select
          value={value}
          onChange={event => setValue(event.target.value)}
        >
          <option value="">{t('starting')}</option>
          {prompt.options?.map(option => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          disabled={value === ''}
          onClick={() => { void controller.answer(prompt.id, value) }}
        >
          {t('submit')}
        </Button>
      </div>
    )
  }

  return (
    <div className={styles['promptInput']}>
      <input
        type={prompt.kind === 'secret' ? 'password' : 'text'}
        value={value}
        placeholder={prompt.placeholder}
        onChange={event => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && value !== '') {
            void controller.answer(prompt.id, value)
          }
        }}
      />
      <Button
        variant="outline"
        disabled={value === ''}
        onClick={() => { void controller.answer(prompt.id, value) }}
      >
        {t('submit')}
      </Button>
    </div>
  )
}
