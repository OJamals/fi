/**
 * The subscription sign-in card: an extension area inside every pi-ai
 * provider card on the Models page, offering OAuth sign-in for the providers
 * whose value is a subscription the user already holds.
 *
 * It renders through the `settings.models.provider-card` slot, which the
 * Models section declares for exactly this purpose — "a plugin distributed
 * outside this repository adds UI to the Models settings section without
 * editing it". The section dispatches the slot keyed by the row's settings
 * namespace, so this card sees every pi-ai row and nothing else; it renders
 * only for the handful of rows an OAuth flow is registered for.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProviderCardExtrasOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { SignInAttempt, SignInRow, SignInStore } from './store.ts'
import type { en } from './locales.ts'
import styles from './SignInCard.module.css'

/** Injected dependencies of {@link SignInCard} (slot `inject`). */
export interface SignInCardInjected {
  /** The card store (loaded on mount, refreshed after every attempt). */
  controller: SignInStore
  hooks: {
    /** Card snapshot bound by the UI renderer as useSnapshot. */
    signIn: SignInStore['store']
  }
  /** Card copy. */
  t: (key: keyof typeof en, params?: Record<string, string>) => string
}

/**
 * Props delivered by the slot outlet: the owner share the Models section
 * dispatches, plus this plugin's inject face spread flat.
 */
export type SignInCardProps = ProviderCardExtrasOwnerProps & Partial<InjectFace<SignInCardInjected>>

/** The question form, which owns its own draft so a keystroke never re-renders the page. */
function PromptForm({ attempt, controller, t }: {
  attempt: SignInAttempt
  controller: SignInStore
  t: SignInCardInjected['t']
}): ReactNode {
  const [draft, setDraft] = useState('')
  const prompt = attempt.prompt
  if (prompt === null) return null
  if (prompt.kind === 'select') {
    return (
      <div className={styles['prompt']}>
        <p className={styles['promptMessage']}>{prompt.message}</p>
        <div className={styles['promptOptions']}>
          {(prompt.options ?? []).map(option => (
            <Button
              key={option.id}
              variant="outline"
              onClick={() => { void controller.answer(option.id) }}
              title={option.description ?? option.label}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <form
      className={styles['prompt']}
      onSubmit={(event) => {
        event.preventDefault()
        if (draft === '') return
        // The draft leaves with the answer and is dropped: a pasted OAuth
        // code is a bearer secret for as long as it is live, and this card is
        // not its store.
        void controller.answer(draft)
        setDraft('')
      }}
    >
      <p className={styles['promptMessage']}>{prompt.message}</p>
      <div className={styles['promptRow']}>
        <Input
          value={draft}
          type={prompt.kind === 'secret' ? 'password' : 'text'}
          placeholder={prompt.placeholder ?? ''}
          aria-label={prompt.message}
          autoComplete="off"
          onChange={(event) => { setDraft(event.currentTarget.value) }}
        />
        <Button variant="primary" type="submit" disabled={draft === ''}>{t('submit')}</Button>
      </div>
    </form>
  )
}

/** The live conversation of one running attempt. */
export function AttemptView({ attempt, controller, t }: {
  attempt: SignInAttempt
  controller: SignInStore
  t: SignInCardInjected['t']
}): ReactNode {
  if (attempt.settled !== null) {
    const { status, message, route } = attempt.settled
    const provider = attempt.key.slice(attempt.key.indexOf('/') + 1)
    return (
      <div className={styles['attempt']} role="status">
        <p className={styles['settled']}>
          {status === 'authorized'
            ? route === 'created'
              ? t('signedInRouteCreated', { provider })
              : route === 'already' ? t('signedInRouteAlready', { provider }) : t('signedIn')
            : status === 'cancelled' ? t('cancelled') : message ?? t('failed')}
        </p>
        <Button variant="ghost" onClick={() => { controller.dismiss() }}>{t('close')}</Button>
      </div>
    )
  }
  return (
    <div className={styles['attempt']}>
      {attempt.notice === null
        ? <p className={styles['notice']} role="status">{t('starting')}</p>
        : (
          <div className={styles['notice']} role="status">
            <p className={styles['noticeMessage']}>{attempt.notice.message}</p>
            {attempt.notice.url === undefined
              ? null
              : (
                <a
                  className={styles['noticeLink']}
                  href={attempt.notice.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {attempt.notice.url}
                </a>
              )}
            {attempt.notice.code === undefined
              ? null
              : <p className={styles['noticeCode']}><code>{attempt.notice.code}</code></p>}
          </div>
        )}
      <PromptForm attempt={attempt} controller={controller} t={t} />
      <Button variant="ghost" onClick={() => { controller.dismiss() }}>{t('cancel')}</Button>
    </div>
  )
}

/** One offered provider's sign-in row. */
function SignInRowView({ row, attempt, controller, t }: {
  row: SignInRow
  attempt: SignInAttempt | null
  controller: SignInStore
  t: SignInCardInjected['t']
}): ReactNode {
  const mine = attempt !== null && attempt.key === row.key
  return (
    <div className={styles['row']}>
      <div className={styles['head']}>
        <span className={styles['identity']}>
          <span
            className={`${styles['dot']} ${row.stored ? styles['dotSignedIn'] : styles['dotSignedOut']}`}
            role="img"
            aria-label={row.stored ? t('stateSignedIn') : t('stateSignedOut')}
            title={row.stored ? t('stateSignedIn') : t('stateSignedOut')}
          />
          <span className={styles['label']}>
            {row.stored ? t('stateSignedIn') : t('subscriptionHint')}
          </span>
        </span>
        {mine
          ? null
          : row.methods.map(method => (
            <Button
              key={method.id}
              variant={row.stored ? 'ghost' : 'outline'}
              /* An attempt elsewhere — a second browser tab — holds the key,
                 and the seam refuses a second one rather than joining it. */
              disabled={attempt !== null || row.inFlight}
              onClick={() => { void controller.begin(row.key, method.id) }}
            >
              {row.stored ? t('signInAgain', { method: method.label }) : method.label}
            </Button>
          ))}
        {mine || !row.stored
          ? null
          : (
            <Button
              variant="ghost"
              disabled={attempt !== null || row.inFlight}
              onClick={() => { void controller.remove(row.key) }}
            >
              {t('removeSignIn')}
            </Button>
          )}
      </div>
      {mine ? <AttemptView attempt={attempt} controller={controller} t={t} /> : null}
    </div>
  )
}

/**
 * The sign-in area of one provider card. Renders nothing unless this exact
 * provider has an OAuth flow registered — every other pi-ai row (and the
 * add-provider draft, which has no route yet) sees an empty area and keeps
 * the layout the Models page already had.
 * @param props - the owner's provider row plus this plugin's inject face.
 * @returns the sign-in area, or nothing.
 */
export function SignInCard(props: SignInCardProps): ReactNode {
  const { provider, controller, useSignIn, t } = props
  /* v8 ignore next -- the renderer always binds the inject face at the render
     call; the guard keeps a direct render without it from throwing. */
  if (controller === undefined || useSignIn === undefined || t === undefined) return null
  return <Bound provider={provider} controller={controller} useSignIn={useSignIn} t={t} />
}

/** The bound half, split so the snapshot hook runs after the inject-face guard. */
function Bound({ provider, controller, useSignIn, t }: {
  provider: ProviderCardExtrasOwnerProps['provider']
  controller: SignInStore
  useSignIn: InjectFace<SignInCardInjected>['useSignIn']
  t: SignInCardInjected['t']
}): ReactNode {
  const state = useSignIn(snapshot => snapshot)
  const row = state.rows.find(candidate => candidate.provider === provider.provider)
  if (row === undefined) return null
  return (
    <div className={styles['card']}>
      <SignInRowView row={row} attempt={state.attempt} controller={controller} t={t} />
    </div>
  )
}
